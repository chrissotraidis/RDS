#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

# test/smoke.rb — Scaffold's own smoke test suite.
#
# FAST tier (default): static assertions on source + template files, hook
# payload parsing, lock behaviour, CLAUDE.md render sanity against fixtures.
# Runs without any external dependencies, under 30 seconds.
#
# FULL tier (--full or SCAFFOLD_SMOKE_FULL=1): also calls the real Claude
# classifier against each fixture. Costs ~$0.01-$0.05/fixture.
#
# Usage:
#   ruby test/smoke.rb              # fast tier
#   ruby test/smoke.rb --full       # fast + full tiers
#   SCAFFOLD_SMOKE_FULL=1 ruby test/smoke.rb
#
# Exits nonzero if any assertion fails.

require "fileutils"
require "json"
require "open3"
require "tmpdir"
require "yaml"

SCAFFOLD_DIR = File.expand_path("..", __dir__)
FIXTURES_DIR = File.join(__dir__, "smoke", "fixtures")

FULL_TIER = ARGV.include?("--full") || ENV["SCAFFOLD_SMOKE_FULL"] == "1"

@pass = 0
@fail = 0
@failures = []

def section(title)
  puts
  puts "═══ #{title} ═══"
end

def assert(name)
  result = yield
  if result == true
    @pass += 1
    puts "  ✓ #{name}"
  else
    @fail += 1
    @failures << "#{name}: #{result}"
    puts "  ✗ #{name}: #{result}"
  end
rescue => e
  @fail += 1
  @failures << "#{name}: #{e.class}: #{e.message}"
  puts "  ✗ #{name}: #{e.class}: #{e.message}"
end

# ─── Helpers ─────────────────────────────────────────────────────────

def syntax_ok(path)
  return "missing" unless File.exist?(path)
  ext = File.extname(path)
  shebang = File.open(path, &:readline) rescue ""
  if ext == ".rb" || shebang =~ /\A#!.*ruby/
    _, err, status = Open3.capture3("ruby", "-c", path)
    status.success? ? true : "ruby -c: #{err.strip}"
  elsif ext == ".sh" || shebang =~ /\A#!.*\b(bash|sh)\b/
    _, err, status = Open3.capture3("bash", "-n", path)
    status.success? ? true : "bash -n: #{err.strip}"
  else
    "unrecognised (ext=#{ext.inspect}, shebang=#{shebang[0, 40].inspect})"
  end
end

# Balanced paren count, ignoring matched-pair URLs/emojis. Returns true or a message.
def balanced_parens(text)
  depth = 0
  text.each_char.with_index do |c, i|
    depth += 1 if c == "("
    depth -= 1 if c == ")"
    return "unmatched ')' at char #{i}" if depth < 0
  end
  depth == 0 ? true : "#{depth} unclosed '(' remaining"
end

# Returns list of suspicious truncation artifacts in a CLAUDE.md body.
def truncation_artifacts(text)
  suspects = []
  text.each_line.with_index do |line, i|
    # "word..." followed by comma or end-of-sentence is the pattern from the
    # old summarize_recipe truncate_text(value, 28) bug — a sentence cut
    # mid-token with ... inserted, often with a dangling "(" preceding it.
    if line =~ /\(\s*[^)(]*\.\.\./ && line !~ /\.\.\.\s*\)/
      suspects << "line #{i + 1}: paren+ellipsis without close: #{line.strip[0, 120]}"
    end
    if line =~ /[a-z]\.\.\.[,\s]/ && line =~ /^-/
      suspects << "line #{i + 1}: mid-token ellipsis in bullet: #{line.strip[0, 120]}"
    end
  end
  suspects
end

def fixtures
  return [] unless Dir.exist?(FIXTURES_DIR)
  Dir.children(FIXTURES_DIR).sort.map { |name| File.join(FIXTURES_DIR, name) }.select { |p| File.directory?(p) }
end

def load_expected(fixture_dir)
  path = File.join(fixture_dir, "expected.yml")
  return {} unless File.exist?(path)
  YAML.safe_load_file(path) || {}
end

# ─── FAST: Syntax checks on all scaffold source + templates ──────────

section "Fast: syntax of source + templates"

ruby_sources = [
  "lib/classify_spec.rb",
  "lib/match_library.rb",
  "lib/generate_claude_md.rb",
  "lib/generate_config_yml.rb",
  "lib/generate_settings_json.rb",
  "lib/render_mockup.rb",
  "lib/validate_tasks.rb",
  "templates/bin/task",
  "templates/lib/scaffold_task/advisory.rb",
  "templates/lib/scaffold_task/runbook.rb",
  "templates/lib/scaffold_task/drift.rb",
  "templates/lib/scaffold_task/sync_proposal.rb",
  "templates/lib/scaffold_task/sync_classifier.rb",
  "templates/lib/scaffold_task/dag_hygiene.rb",
  "templates/lib/publish_to_wiki.rb"
]
shell_sources = [
  "scaffold.sh",
  "templates/launch-build.sh",
  "templates/.claude/hooks/context-guard.sh",
  "templates/.claude/hooks/stop-gate.sh",
  "templates/lib/launch-build/lock.sh",
  "templates/lib/launch-build/remediation.sh"
]

(ruby_sources + shell_sources).each do |rel|
  assert(rel) { syntax_ok(File.join(SCAFFOLD_DIR, rel)) }
end

# ─── FAST: Context-guard payload parsing ─────────────────────────────

section "Fast: context-guard.sh JSON parsing"

hook = File.join(SCAFFOLD_DIR, "templates/.claude/hooks/context-guard.sh")

def run_hook(hook, payload)
  _, err, status = Open3.capture3("bash", hook, stdin_data: payload)
  [status.exitstatus, err]
end

# (A) real spec.md edit must block (exit 2)
payload_spec_edit = '{"tool_name":"Edit","tool_input":{"file_path":"spec.md","old_string":"x","new_string":"y"}}'
assert("blocks real spec.md edit") do
  code, _ = run_hook(hook, payload_spec_edit)
  code == 2 ? true : "exit=#{code}"
end

# (B) benign edit whose new_string CONTAINS "file_path":"spec.md" must NOT block
payload_content_lookalike = '{"tool_name":"Edit","tool_input":{"file_path":"app/models/user.rb","old_string":"old","new_string":"\"file_path\":\"spec.md\""}}'
assert("allows edit whose content contains a lookalike file_path") do
  code, _ = run_hook(hook, payload_content_lookalike)
  code == 0 ? true : "exit=#{code} (should be 0 — lookalike in new_string was false-matched)"
end

# (C) JSON with key order reversed (file_path last) — must still block for spec.md
payload_reordered = '{"tool_name":"Edit","tool_input":{"old_string":"x","new_string":"y","file_path":"spec.md"}}'
assert("blocks spec.md even when file_path is last key") do
  code, _ = run_hook(hook, payload_reordered)
  code == 2 ? true : "exit=#{code}"
end

# (D) .scaffold/ path must block
payload_scaffold = '{"tool_name":"Write","tool_input":{"file_path":".scaffold/telemetry/5.json","content":"..."}}'
assert("blocks .scaffold/ writes") do
  code, _ = run_hook(hook, payload_scaffold)
  code == 2 ? true : "exit=#{code}"
end

# ─── FAST: Lock behaviour ─────────────────────────────────────────────

section "Fast: acquire_build_lock stale + race handling"

lock_script = File.join(SCAFFOLD_DIR, "templates/lib/launch-build/lock.sh")

def invoke_lock_in_dir(dir, lock_script, extra_setup = "")
  script = <<~BASH
    set -u
    cd "#{dir}"
    LOCKDIR=".scaffold/build.lock"
    mkdir -p .scaffold
    #{extra_setup}
    source "#{lock_script}"
    acquire_build_lock
  BASH
  Open3.capture3("bash", "-c", script)
end

Dir.mktmpdir("smoke-lock-") do |tmp|
  # Stale lock with dead PID — must clean + acquire.
  FileUtils.mkdir_p(File.join(tmp, ".scaffold/build.lock"))
  File.write(File.join(tmp, ".scaffold/build.lock/pid"), "#{`hostname`.strip}\n99999999\n")
  out, err, status = invoke_lock_in_dir(tmp, lock_script)
  assert("cleans stale-PID lock and acquires") do
    if status.success? && File.exist?(File.join(tmp, ".scaffold/build.lock/pid"))
      true
    else
      "exit=#{status.exitstatus} err=#{err.lines.first}"
    end
  end
end

Dir.mktmpdir("smoke-lock-") do |tmp|
  # Live lock (current process PID) — must refuse.
  FileUtils.mkdir_p(File.join(tmp, ".scaffold/build.lock"))
  File.write(File.join(tmp, ".scaffold/build.lock/pid"), "#{`hostname`.strip}\n#{Process.pid}\n")
  out, err, status = invoke_lock_in_dir(tmp, lock_script)
  assert("refuses live-PID lock") do
    # lock.sh echoes errors to stdout, not stderr.
    combined = "#{out}#{err}"
    (!status.success? && combined.include?("Another build is already running")) ?
      true : "exit=#{status.exitstatus} out=#{out.lines.first.to_s.strip.inspect} err=#{err.lines.first.to_s.strip.inspect}"
  end
end

# ─── FAST: CLAUDE.md render sanity on fixtures ────────────────────────

section "Fast: scaffold dry-run against fixtures"

fixtures_found = fixtures
if fixtures_found.empty?
  puts "  (no fixtures in #{FIXTURES_DIR} — skipping fixture assertions)"
end

fixtures_found.each do |fixture_dir|
  name = File.basename(fixture_dir)
  spec_path = File.join(fixture_dir, "spec.md")
  expected = load_expected(fixture_dir)
  unless File.exist?(spec_path)
    assert("[#{name}] spec.md present") { "missing #{spec_path}" }
    next
  end

  puts
  puts "  fixture: #{name}"

  # Deterministic keyword-matcher classification. Fast tier only asserts
  # primary_recipe — it's the signal match_library.rb is genuinely reliable
  # for. Persona and domain come from broader keyword spaces where the
  # matcher's recall is weak; the --full tier checks those via Claude.
  if expected["primary_recipe"]
    out, err, status = Open3.capture3(
      "ruby", File.join(SCAFFOLD_DIR, "lib/match_library.rb"),
      "--spec", spec_path,
      "--library", File.join(SCAFFOLD_DIR, "library")
    )
    assert("[#{name}] match_library succeeds") do
      status.success? ? true : "exit=#{status.exitstatus}: #{err.lines.last}"
    end
    if status.success?
      result = JSON.parse(out) rescue {}
      assert("[#{name}] match_library primary_recipe == #{expected["primary_recipe"]}") do
        got = result.dig("primary_recipe", "name")
        got == expected["primary_recipe"] ? true : "got=#{got.inspect}"
      end
    end
  end

  Dir.mktmpdir("smoke-#{name}-") do |out|
    # Dry-run scaffold using the deterministic keyword matcher (no Claude).
    stdout, err, status = Open3.capture3(
      { "SCAFFOLD_SKIP_CLAUDE_CLASSIFY" => "1" },
      "bash", File.join(SCAFFOLD_DIR, "scaffold.sh"),
      spec_path, "--output", out,
      "--skip-rules", "--skip-tasks"
    )

    assert("[#{name}] scaffold dry-run succeeds") do
      if status.success?
        true
      else
        tail = (err.lines.last(5) + stdout.lines.last(5)).reject(&:empty?).join.strip
        "exit=#{status.exitstatus}: #{tail}"
      end
    end

    # Classification assertion (fast tier: via match_library.rb, already embedded in the dry-run above).
    config_path = File.join(out, "config.yml")
    claude_md = File.join(out, "CLAUDE.md")

    if expected["primary_recipe"] && File.exist?(config_path)
      config = YAML.safe_load_file(config_path, permitted_classes: [Symbol])
      detected = Array(config["detected_stacks"])
      expected_stack = expected["detected_stack"]
      if expected_stack
        assert("[#{name}] detected_stacks includes #{expected_stack}") do
          detected.include?(expected_stack) ? true : "got #{detected.inspect}"
        end
      end
    end

    if File.exist?(claude_md)
      body = File.read(claude_md, encoding: "utf-8")

      assert("[#{name}] CLAUDE.md balanced parens") { balanced_parens(body) }

      assert("[#{name}] CLAUDE.md no truncation artifacts") do
        arts = truncation_artifacts(body)
        arts.empty? ? true : arts.first
      end

      assert("[#{name}] CLAUDE.md has Project Summary section") do
        body.include?("## Project Summary") ? true : "missing ## Project Summary"
      end

      assert("[#{name}] CLAUDE.md Tech Stack row well-formed") do
        tech_line = body.lines.find { |l| l.start_with?("- Supporting:") }
        if tech_line.nil?
          true # Supporting line is optional
        elsif tech_line.count("(") != tech_line.count(")")
          "Supporting line paren mismatch: #{tech_line.strip[0, 140]}"
        else
          true
        end
      end
    end
  end

  # Dossier goldens (if present in fixture).
  golden_dossier = File.join(fixture_dir, "golden", "dossier-0.md")
  tasks_json = File.join(fixture_dir, "tasks.json")
  if File.exist?(golden_dossier) && File.exist?(tasks_json)
    Dir.mktmpdir("smoke-dossier-#{name}-") do |work|
      FileUtils.cp(tasks_json, File.join(work, "tasks.json"))
      # Dossier reads CLAUDE.md / runbook.md optionally; write a stub runbook.
      runbook_fixture = File.join(fixture_dir, "runbook.md")
      FileUtils.cp(runbook_fixture, File.join(work, "runbook.md")) if File.exist?(runbook_fixture)
      FileUtils.mkdir_p(File.join(work, "bin"))
      FileUtils.mkdir_p(File.join(work, "lib/scaffold_task"))
      FileUtils.cp(File.join(SCAFFOLD_DIR, "templates/bin/task"), File.join(work, "bin/task"))
      Dir.glob(File.join(SCAFFOLD_DIR, "templates/lib/scaffold_task/*.rb")).each do |src|
        FileUtils.cp(src, File.join(work, "lib/scaffold_task", File.basename(src)))
      end
      FileUtils.chmod("+x", File.join(work, "bin/task"))

      out, err, status = Open3.capture3("ruby", "bin/task", "dossier", "0", chdir: work)
      assert("[#{name}] bin/task dossier 0 succeeds") do
        status.success? ? true : "exit=#{status.exitstatus}: #{err.lines.first}"
      end

      if status.success?
        expected_body = File.read(golden_dossier, encoding: "utf-8")
        assert("[#{name}] dossier 0 matches golden") do
          out == expected_body ? true : "diff (run: ruby test/smoke.rb --update-golden #{name} to refresh)"
        end
      end
    end
  end
end

# ─── FULL tier: classify_spec.rb with real Claude ────────────────────

if FULL_TIER
  section "Full: Claude classifier against fixtures"

  unless system("which claude > /dev/null 2>&1")
    puts "  (claude CLI not on PATH — skipping full tier)"
  else
    fixtures_found.each do |fixture_dir|
      name = File.basename(fixture_dir)
      spec_path = File.join(fixture_dir, "spec.md")
      expected = load_expected(fixture_dir)
      next unless File.exist?(spec_path) && expected["primary_recipe"]

      Dir.mktmpdir("smoke-classify-#{name}-") do |cache|
        out, err, status = Open3.capture3(
          "ruby", File.join(SCAFFOLD_DIR, "lib/classify_spec.rb"),
          "--spec", spec_path,
          "--library", File.join(SCAFFOLD_DIR, "library"),
          "--cache-dir", cache,
          "--no-cache"
        )

        assert("[#{name}] classifier call succeeds") do
          status.success? ? true : "exit=#{status.exitstatus}: #{err.lines.last(2).join.strip}"
        end

        next unless status.success?

        result = JSON.parse(out) rescue nil
        if result.nil?
          assert("[#{name}] classifier emits valid JSON") { "parse error" }
          next
        end

        assert("[#{name}] primary_recipe == #{expected["primary_recipe"]}") do
          got = result.dig("primary_recipe", "name")
          got == expected["primary_recipe"] ? true : "got=#{got.inspect}"
        end

        if expected["persona"]
          assert("[#{name}] persona == #{expected["persona"]}") do
            got = result.dig("persona", "name")
            got == expected["persona"] ? true : "got=#{got.inspect}"
          end
        end

        if Array(expected["domains_any_of"]).any?
          got = Array(result["domains"]).map { |d| d["name"] }
          assert("[#{name}] domains overlap with #{expected["domains_any_of"]}") do
            (got & expected["domains_any_of"]).any? ? true : "got=#{got.inspect}"
          end
        end
      end
    end
  end
end

# ─── FAST: render_mockup deterministic renderer ─────────────────────

section "Fast: render_mockup.rb"

RENDER_MOCKUP_PATH = File.join(SCAFFOLD_DIR, "lib/render_mockup.rb")
MOCKUP_TEMPLATE_PATH = File.join(SCAFFOLD_DIR, "templates/mockup_preview.html.erb")

Dir.mktmpdir("scaffold-mockup-smoke") do |tmp|
  manifest = {
    "project_name" => "Test App",
    "roles" => ["admin", "user"],
    "screens" => [
      {
        "id" => "login", "name" => "Login", "role" => "shared",
        "description" => "Sign in", "components" => ["form"],
        "data_entities" => [{ "entity" => "Credential", "displayed_fields" => ["email", "password"] }]
      },
      {
        "id" => "admin-dash", "name" => "Admin Dashboard", "role" => "admin",
        "components" => ["kpi", "data_table"],
        "interactive_elements" => ["search_filter", "date_picker"],
        "data_entities" => [{ "entity" => "User", "displayed_fields" => ["name", "email", "role"] }]
      },
      {
        "id" => "user-home", "name" => "Home", "role" => "user",
        "components" => ["card_grid"],
        "data_entities" => [{ "entity" => "Post", "displayed_fields" => ["title", "body"] }]
      }
    ],
    "navigation" => {
      "admin" => [{ "label" => "Dashboard", "screen_id" => "admin-dash" }],
      "user"  => [{ "label" => "Home", "screen_id" => "user-home" }]
    },
    "layout" => { "type" => "sidebar" },
    "seed_data" => {
      "User" => [
        { "name" => "Ada Lovelace", "email" => "ada@example.com", "role" => "admin" },
        { "name" => "Grace Hopper", "email" => "grace@example.com", "role" => "user" }
      ],
      "Post" => [
        { "title" => "First post", "body" => "Hello world" }
      ]
    }
  }
  manifest_path = File.join(tmp, "manifest.json")
  File.write(manifest_path, JSON.pretty_generate(manifest))

  out_dir = File.join(tmp, "mockup")
  _out, err, status = Open3.capture3(
    "ruby", RENDER_MOCKUP_PATH, "--manifest", manifest_path, "--output", out_dir
  )

  assert "render_mockup exits 0 on a valid manifest" do
    status.success?
  end

  html_path = File.join(out_dir, "index.html")

  assert "render_mockup writes index.html" do
    File.exist?(html_path) && File.size(html_path) > 0
  end

  html = File.exist?(html_path) ? File.read(html_path, encoding: "UTF-8") : ""

  assert "render_mockup emits DOCTYPE and alpine.js" do
    html.include?("<!DOCTYPE html>") && html.include?("alpinejs@3")
  end

  assert "render_mockup embeds the project name" do
    html.include?("Test App")
  end

  assert "render_mockup renders every screen container" do
    ["login", "admin-dash", "user-home"].all? { |id| html.include?("currentScreen === '#{id}'") }
  end

  assert "render_mockup embeds role-scoped navigation" do
    html.include?('"admin"') && html.include?('"user"') && html.include?("admin-dash") && html.include?("user-home")
  end

  assert "render_mockup renders seed data into data_table rows" do
    html.include?("Ada Lovelace") && html.include?("Grace Hopper")
  end

  assert "render_mockup renders card_grid from seed data" do
    html.include?("First post")
  end

  assert "render_mockup handles unknown components as labelled placeholders" do
    # Manifest with a made-up component type should still render without error.
    odd_manifest = manifest.merge(
      "screens" => [manifest["screens"][0].merge("components" => ["unobtainium_widget"])]
    )
    odd_path = File.join(tmp, "odd.json")
    File.write(odd_path, JSON.pretty_generate(odd_manifest))
    odd_out = File.join(tmp, "odd-mockup")
    _, _, st = Open3.capture3("ruby", RENDER_MOCKUP_PATH, "--manifest", odd_path, "--output", odd_out)
    st.success? && File.read(File.join(odd_out, "index.html")).include?("Unobtainium widget")
  end

  assert "render_mockup handles empty seed_data without crashing" do
    minimal = { "project_name" => "Min", "roles" => ["user"], "screens" => [
      { "id" => "home", "name" => "Home", "role" => "user", "components" => ["data_table"] }
    ], "seed_data" => {} }
    mp = File.join(tmp, "min.json")
    File.write(mp, JSON.pretty_generate(minimal))
    mo = File.join(tmp, "min-mockup")
    _, _, st = Open3.capture3("ruby", RENDER_MOCKUP_PATH, "--manifest", mp, "--output", mo)
    st.success?
  end

  # Template assertion: ensure the ERB template exists where the renderer looks.
  assert "mockup_preview.html.erb template exists" do
    File.exist?(MOCKUP_TEMPLATE_PATH)
  end

  # Regression: stderr should stay quiet on the happy path.
  assert "render_mockup stays quiet on happy path (just the summary line)" do
    err.lines.size <= 2 && err.include?("Rendered")
  end

  # ── Layout.type branching ───────────────────────────────────────────

  def render_with_layout(tmp, base_manifest, layout_type)
    m = base_manifest.merge("layout" => { "type" => layout_type })
    mp = File.join(tmp, "m-#{layout_type}.json")
    File.write(mp, JSON.pretty_generate(m))
    out = File.join(tmp, "out-#{layout_type}")
    _, _, st = Open3.capture3("ruby", RENDER_MOCKUP_PATH, "--manifest", mp, "--output", out)
    [st.success?, File.read(File.join(out, "index.html"), encoding: "UTF-8")]
  end

  assert "render_mockup honors layout.type=sidebar (default shell)" do
    ok, html = render_with_layout(tmp, manifest, "sidebar")
    ok &&
      html.include?("layout.type: sidebar") &&
      html.include?("<aside") &&
      !html.include?("layout.type: top_nav") &&
      !html.include?("layout.type: bottom_tabs")
  end

  assert "render_mockup honors layout.type=top_nav (horizontal header nav)" do
    ok, html = render_with_layout(tmp, manifest, "top_nav")
    ok &&
      html.include?("layout.type: top_nav") &&
      !html.include?("<aside")
  end

  assert "render_mockup honors layout.type=bottom_tabs (mobile chrome)" do
    ok, html = render_with_layout(tmp, manifest, "bottom_tabs")
    ok &&
      html.include?("layout.type: bottom_tabs") &&
      html.include?("max-w-md") &&
      !html.include?("<aside")
  end

  # ── List "View" navigation wiring ──────────────────────────────────

  assert "list renders @click=navigate() to related detail screen" do
    list_manifest = {
      "project_name" => "List Test",
      "roles" => ["user"],
      "screens" => [
        {
          "id" => "posts-index", "name" => "Posts", "role" => "user",
          "components" => ["list"], "related_screens" => ["post-detail"],
          "data_entities" => [{ "entity" => "Post", "displayed_fields" => ["title", "author"] }]
        },
        {
          "id" => "post-detail", "name" => "Post", "role" => "user",
          "components" => ["detail_view"],
          "data_entities" => [{ "entity" => "Post", "displayed_fields" => ["title", "author"] }]
        }
      ],
      "seed_data" => {
        "Post" => [{ "title" => "Hello", "author" => "Ada" }, { "title" => "World", "author" => "Grace" }]
      }
    }
    mp = File.join(tmp, "list-rel.json")
    File.write(mp, JSON.pretty_generate(list_manifest))
    out = File.join(tmp, "out-list-rel")
    _, _, st = Open3.capture3("ruby", RENDER_MOCKUP_PATH, "--manifest", mp, "--output", out)
    html = File.read(File.join(out, "index.html"), encoding: "UTF-8")
    st.success? && html.include?(%(@click="navigate('post-detail')"))
  end

  assert "list renders muted placeholder when no related_screens" do
    list_manifest = {
      "project_name" => "List No Rel",
      "roles" => ["user"],
      "screens" => [
        {
          "id" => "posts-index", "name" => "Posts", "role" => "user",
          "components" => ["list"],
          "data_entities" => [{ "entity" => "Post", "displayed_fields" => ["title"] }]
        }
      ],
      "seed_data" => { "Post" => [{ "title" => "Only post" }] }
    }
    mp = File.join(tmp, "list-no-rel.json")
    File.write(mp, JSON.pretty_generate(list_manifest))
    out = File.join(tmp, "out-list-no-rel")
    _, _, st = Open3.capture3("ruby", RENDER_MOCKUP_PATH, "--manifest", mp, "--output", out)
    html = File.read(File.join(out, "index.html"), encoding: "UTF-8")
    # No navigate() wired on the list row — just the muted em-dash span.
    st.success? &&
      !html.match?(/<li[^>]*>[^<]*<div[^<]*<div[^<]*Only post.*?@click="navigate\('[^']*'\)"/m) &&
      html.include?("Only post")
  end

  assert "list prefers detail-shaped related_screens when multiple candidates" do
    list_manifest = {
      "project_name" => "Pref Detail",
      "roles" => ["user"],
      "screens" => [
        {
          "id" => "items-index", "name" => "Items", "role" => "user",
          "components" => ["list"],
          "related_screens" => ["items-settings", "item-detail", "items-help"],
          "data_entities" => [{ "entity" => "Item", "displayed_fields" => ["name"] }]
        },
        { "id" => "item-detail",    "name" => "Item Detail",    "role" => "user", "components" => ["detail_view"] },
        { "id" => "items-settings", "name" => "Items Settings", "role" => "user", "components" => ["form"] },
        { "id" => "items-help",     "name" => "Items Help",     "role" => "user", "components" => [] }
      ],
      "seed_data" => { "Item" => [{ "name" => "Widget" }] }
    }
    mp = File.join(tmp, "list-pref.json")
    File.write(mp, JSON.pretty_generate(list_manifest))
    out = File.join(tmp, "out-list-pref")
    _, _, st = Open3.capture3("ruby", RENDER_MOCKUP_PATH, "--manifest", mp, "--output", out)
    html = File.read(File.join(out, "index.html"), encoding: "UTF-8")
    st.success? && html.include?(%(@click="navigate('item-detail')"))
  end
end

# ─── FAST: bin/task sync modules — unit-style coverage ──────────────

section "Fast: bin/task sync modules"

# Resolve absolute paths BEFORE Dir.chdir so __FILE__ isn't interpreted
# relative to the tmpdir. The sync modules live in templates/lib/scaffold_task/.
SCAFFOLD_ROOT = File.expand_path("..", __dir__)
SYNC_MODULE_PATHS = %w[sync_proposal dag_hygiene drift sync_classifier].map do |mod|
  File.join(SCAFFOLD_ROOT, "templates/lib/scaffold_task/#{mod}.rb")
end

Dir.mktmpdir("scaffold-sync-smoke") do |tmp|
  Dir.chdir(tmp) do
    # Minimal setup so filesystem-backed tests have somewhere to write.
    FileUtils.mkdir_p(".scaffold/task-details")

    module_paths = SYNC_MODULE_PATHS

    # --- SyncProposal round-trip ---
    assert "[sync] SyncProposal.write + parse round-trip" do
      module_paths.each { |p| require p }

      top = {"generated_against_sha" => "abc", "last_synced_spec_sha" => "def", "generated_at" => "2026-04-18T00:00:00Z"}
      changes = [
        {frontmatter: {"change_id" => "C-001", "status" => "accept", "classification" => "new-task",
                       "confidence" => "high", "provenance" => {"spec_diff_hunk" => "@@ ..."},
                       "target" => {"position" => 42, "depends_on" => [1]}},
         body: "### Proposed task 42\n\n<details><summary>Raw task payload</summary>\n\n```json\n{\"title\":\"X\",\"done_when\":\"Y\"}\n```\n\n</details>"},
        {frontmatter: {"change_id" => "C-002", "status" => "reject", "classification" => "refinement-noop",
                       "confidence" => "low", "provenance" => {"spec_diff_hunk" => "@@ ..."}},
         body: "### C-002: noop"}
      ]
      ScaffoldTask::SyncProposal.write(top: top, changes: changes, path: ".scaffold/sync-proposal.md")
      parsed = ScaffoldTask::SyncProposal.parse(".scaffold/sync-proposal.md")
      ScaffoldTask::SyncProposal.validate!(parsed)
      parsed[:changes].length == 2 && parsed[:changes][0][:frontmatter]["change_id"] == "C-001"
    end

    assert "[sync] SyncProposal.extract_task_payload from details block" do
      body = "prose\n<details><summary>Raw task payload</summary>\n\n```json\n{\"title\":\"T\",\"done_when\":\"D\"}\n```\n\n</details>"
      payload = ScaffoldTask::SyncProposal.extract_task_payload(body)
      payload && payload["title"] == "T" && payload["done_when"] == "D"
    end

    assert "[sync] SyncProposal.parse tolerates markdown horizontal rules in body" do
      # A change body containing a markdown HR (`---` between prose blocks)
      # must not be mistaken for a new fence. Only `---` followed by a YAML
      # key line opens a fence.
      proposal = <<~MD
        ---
        generated_against_sha: abc
        last_synced_spec_sha: def
        generated_at: 2026-04-18T12:00:00Z
        ---

        # Top body

        ---
        change_id: C-001
        status: accept
        classification: new-task
        confidence: high
        provenance:
          spec_diff_hunk: "@@ ..."
        ---

        Some prose.

        ---

        More prose after a horizontal rule (this --- should NOT be a fence).
      MD
      File.write("hr-test.md", proposal)
      parsed = ScaffoldTask::SyncProposal.parse("hr-test.md")
      parsed[:changes].length == 1 && parsed[:changes][0][:frontmatter]["change_id"] == "C-001"
    end

    assert "[sync] SyncProposal.parse handles YAML timestamp without NameError" do
      # Exercises require "date" — permitted_classes references Date and Time;
      # parsing must not fail with NameError even on a fresh Ruby process.
      proposal = <<~MD
        ---
        generated_against_sha: abc
        last_synced_spec_sha: def
        generated_at: 2026-04-18T12:00:00Z
        ---

        (empty body)
      MD
      File.write("timestamp-test.md", proposal)
      parsed = ScaffoldTask::SyncProposal.parse("timestamp-test.md")
      !parsed[:top]["generated_at"].nil?
    end

    assert "[sync] SyncProposal.validate! rejects missing confidence" do
      parsed = {
        top: {"generated_against_sha" => "x", "last_synced_spec_sha" => "y", "generated_at" => "z"},
        changes: [{frontmatter: {"change_id" => "C-1", "status" => "accept",
                                 "classification" => "new-task",
                                 "provenance" => {"spec_diff_hunk" => "@@"}}, body: ""}]
      }
      begin
        ScaffoldTask::SyncProposal.validate!(parsed)
        false
      rescue ScaffoldTask::SyncProposal::ValidationError
        true
      end
    end

    # --- DAG hygiene ---

    assert "[sync] DagHygiene.find_cycle detects simple cycle" do
      tasks = [{"position" => 1, "depends_on" => [2]}, {"position" => 2, "depends_on" => [1]}]
      cycle = ScaffoldTask::DagHygiene.find_cycle(tasks)
      cycle && cycle.length >= 2
    end

    assert "[sync] DagHygiene.find_cycle returns nil for acyclic" do
      tasks = [{"position" => 1, "depends_on" => []}, {"position" => 2, "depends_on" => [1]},
               {"position" => 3, "depends_on" => [1, 2]}]
      ScaffoldTask::DagHygiene.find_cycle(tasks).nil?
    end

    assert "[sync] DagHygiene.transitive_reduce! prunes redundant edge" do
      tasks = [{"position" => 1, "depends_on" => []}, {"position" => 2, "depends_on" => [1]},
               {"position" => 3, "depends_on" => [1, 2]}]
      pruned = ScaffoldTask::DagHygiene.transitive_reduce!(tasks)
      pruned.length == 1 && pruned[0][:pruned] == [1] &&
        tasks.find { |t| t["position"] == 3 }["depends_on"] == [2]
    end

    assert "[sync] DagHygiene.transitive_reduce! no-op on minimal graph" do
      tasks = [{"position" => 1, "depends_on" => []}, {"position" => 2, "depends_on" => [1]}]
      ScaffoldTask::DagHygiene.transitive_reduce!(tasks).empty?
    end

    # --- Drift detection ---

    assert "[sync] Drift.cheap_probe? skips HTTP probes" do
      !ScaffoldTask::Drift.cheap_probe?("curl -sf \"$APP_BASE_URL/x\"")
    end

    assert "[sync] Drift.cheap_probe? skips rails commands" do
      !ScaffoldTask::Drift.cheap_probe?("bin/rails test")
    end

    assert "[sync] Drift.cheap_probe? accepts pure file scans" do
      ScaffoldTask::Drift.cheap_probe?("test -f app/foo.rb")
    end

    assert "[sync] Drift.detect flags failing probe" do
      # Create a task that asserts presence of a file we don't create
      File.write(".scaffold/task-details/1.json",
        JSON.generate({"position" => 1, "title" => "T",
                       "verification" => {"commands" => [
                         {"name" => "file present", "primitive_type" => "file_exists",
                          "command" => "test -f app/does_not_exist.rb",
                          "required" => true, "gate_type" => "blocking"}]}}))
      tasks = [{"position" => 1, "title" => "T", "status" => "done"}]
      reports = ScaffoldTask::Drift.detect(tasks, detail_dir: ".scaffold/task-details")
      reports.length == 1 && reports[0][:failures].length == 1
    end

    # --- SyncClassifier output parsing ---

    assert "[sync] SyncClassifier.parse_classifier_output handles plain JSON" do
      arr = ScaffoldTask::SyncClassifier.parse_classifier_output('[{"change_id":"C-1"}]')
      arr.length == 1 && arr[0]["change_id"] == "C-1"
    end

    assert "[sync] SyncClassifier.parse_classifier_output strips markdown fences" do
      raw = "Some preamble\n```json\n[{\"change_id\":\"C-1\"}]\n```\n"
      arr = ScaffoldTask::SyncClassifier.parse_classifier_output(raw)
      arr.length == 1
    end

    assert "[sync] SyncClassifier.compare_entries full agreement" do
      first = {"classification" => "new-task",
               "target" => {"depends_on" => [1]},
               "task_payload" => {"done_when" => "D"}}
      result = ScaffoldTask::SyncClassifier.compare_entries(first, first.dup)
      result["agreement"] == "full" && result["downgrade_confidence"] == false
    end

    assert "[sync] SyncClassifier.compare_entries detects classification divergence" do
      first = {"classification" => "new-task", "target" => {"depends_on" => []}, "task_payload" => {"done_when" => "D"}}
      critic = first.merge("classification" => "refinement-noop")
      result = ScaffoldTask::SyncClassifier.compare_entries(first, critic)
      result["agreement"] == "classification-divergent" && result["downgrade_confidence"] == true
    end

    assert "[sync] SyncClassifier.compare_entries detects payload divergence on done_when" do
      first = {"classification" => "new-task", "target" => {"depends_on" => []}, "task_payload" => {"done_when" => "A"}}
      critic = first.merge("task_payload" => {"done_when" => "B"})
      result = ScaffoldTask::SyncClassifier.compare_entries(first, critic)
      result["agreement"] == "payload-divergent" && result["downgrade_confidence"] == false
    end
  end
end

# ─── Summary ─────────────────────────────────────────────────────────

puts
puts "═══ Summary ═══"
puts "  #{@pass} passed, #{@fail} failed"
unless @failures.empty?
  puts
  puts "Failures:"
  @failures.each { |f| puts "  - #{f}" }
end

exit(@fail == 0 ? 0 : 1)
