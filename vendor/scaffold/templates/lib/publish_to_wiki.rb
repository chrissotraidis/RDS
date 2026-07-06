#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# publish_to_wiki.rb -- Push build evidence from completed tasks into the product wiki.
#
# Reads all completed task detail bundles from .scaffold/task-details/*.json,
# aggregates evidence (confirmed entities, routes, addressed risks, decisions),
# and writes a single review/build-evidence.json into the wiki directory.
#
# The wiki's maintenance cycle picks up this file and
# integrates it via the answer-integrator skill.
#
# Usage:
#   ruby lib/publish_to_wiki.rb --wiki-dir /path/to/wiki
#   ruby lib/publish_to_wiki.rb                          # auto-detect from config.yml
#
# Requires only Ruby stdlib (json, yaml, optparse, time).

require "json"
require "yaml"
require "optparse"
require "time"

class WikiPublisher
  RISKS_PAGE = "operations/risks-and-known-gaps.md"
  EVIDENCE_PATH = "review/build-evidence.json"

  attr_reader :wiki_dir

  def initialize(wiki_dir)
    @wiki_dir = wiki_dir
  end

  # Main entry point. Reads tasks.json + task detail bundles, writes evidence.
  def reconcile(tasks_json_path = "tasks.json")
    unless File.directory?(wiki_dir)
      $stderr.puts "Wiki bridge: SKIP (wiki dir not found: #{wiki_dir})"
      return nil
    end

    unless File.exist?(tasks_json_path)
      $stderr.puts "Wiki bridge: SKIP (tasks.json not found)"
      return nil
    end

    doc = JSON.parse(File.read(tasks_json_path, encoding: "UTF-8"))
    tasks = doc["tasks"] || []
    completed = tasks.select { |t| t["status"] == "done" }

    if completed.empty?
      $stderr.puts "Wiki bridge: SKIP (no completed tasks)"
      return nil
    end

    # Aggregate evidence across all completed tasks
    confirmed_entities = {}
    confirmed_routes = []
    risks_addressed = []
    decisions = []
    risk_map = build_risk_map

    completed.each do |task|
      pos = task["position"]
      detail = load_task_detail(pos)
      next unless detail

      metadata = detail["task_metadata"] || task
      title = detail["title"] || task["title"]
      entities = Array(metadata["entities_touched"])
      verification = detail.dig("verification", "commands") || []
      acceptance = Array(detail["acceptance_criteria"])
      runbook = detail["runbook"].to_s.strip
      requirement_refs = Array(metadata["requirement_refs"])

      # Confirmed entities — deduplicate across tasks
      entities.each do |entity|
        confirmed_entities[entity] ||= { "confirmed_by_tasks" => [], "fields_observed" => [] }
        confirmed_entities[entity]["confirmed_by_tasks"] << pos
        # Extract fields from acceptance_criteria model_has params
        acceptance.each do |ac|
          next unless ac["type"] == "model_has"
          params = parse_params(ac["params"])
          if params["model"] == entity && params["columns"]
            confirmed_entities[entity]["fields_observed"] |= Array(params["columns"])
          end
        end
      end

      # Confirmed routes — from acceptance_criteria and verification commands
      acceptance.each do |ac|
        next unless %w[route_exists http].include?(ac["type"])
        params = parse_params(ac["params"])
        method = params["method"] || "GET"
        path = params["path"]
        next unless path
        confirmed_routes << { "method" => method, "path" => path, "confirmed_by_task" => pos }
      end
      extract_routes_from_commands(verification).each do |route|
        confirmed_routes << route.merge("confirmed_by_task" => pos)
      end

      # Risks addressed — cross-reference entities against wiki risk map
      entities.each do |entity|
        severity = risk_map[entity]
        next unless severity
        existing = risks_addressed.find { |r| r["entity"] == entity }
        if existing
          existing["mitigated_by_tasks"] << pos unless existing["mitigated_by_tasks"].include?(pos)
        else
          risks_addressed << { "entity" => entity, "severity" => severity, "mitigated_by_tasks" => [pos] }
        end
      end

      # Decisions
      summary = runbook.empty? ? title : runbook.lines.first.to_s.strip
      decisions << {
        "task_position" => pos,
        "title" => title,
        "summary" => summary,
        "requirement_refs" => requirement_refs
      }
    end

    # Deduplicate routes
    confirmed_routes.uniq! { |r| [r["method"], r["path"]] }

    evidence = {
      "schema_version" => 1,
      "generated_at" => Time.now.utc.iso8601,
      "source_project" => Dir.pwd,
      "confirmed_entities" => confirmed_entities,
      "confirmed_routes" => confirmed_routes,
      "risks_addressed" => risks_addressed,
      "decisions" => decisions,
      "build_summary" => {
        "total_tasks" => tasks.size,
        "completed_tasks" => completed.size,
        "entities_confirmed" => confirmed_entities.size,
        "routes_confirmed" => confirmed_routes.size
      }
    }

    write_evidence(evidence)
    evidence
  end

  private

  def load_task_detail(position)
    path = ".scaffold/task-details/#{position}.json"
    return nil unless File.exist?(path)
    JSON.parse(File.read(path, encoding: "UTF-8"))
  rescue JSON::ParserError
    $stderr.puts "  Warning: Could not parse task detail #{path}"
    nil
  end

  def parse_params(params)
    return params if params.is_a?(Hash)
    return JSON.parse(params) if params.is_a?(String)
    {}
  rescue JSON::ParserError
    {}
  end

  # Extract route patterns from verification shell commands.
  def extract_routes_from_commands(commands)
    routes = []
    commands.each do |cmd|
      command_str = (cmd.is_a?(Hash) ? cmd["command"] : cmd).to_s

      # Match curl with explicit method: curl -X POST .../path
      command_str.scan(/-X\s+(GET|POST|PUT|PATCH|DELETE)\s+[^\s]*?(\/[^\s"']+)/).each do |method, path|
        path = path.sub(/\$\{?APP_BASE_URL\}?/, "").sub(%r{^https?://[^/]+}, "")
        routes << { "method" => method, "path" => path } unless path.empty?
      end

      # Match curl -sf $APP_BASE_URL/path (implicit GET)
      command_str.scan(/curl\s+[^|]*?\$\{?APP_BASE_URL\}?(\/[^\s"'|]+)/).each do |path,|
        routes << { "method" => "GET", "path" => path } unless routes.any? { |r| r["path"] == path }
      end
    end
    routes.uniq { |r| [r["method"], r["path"]] }
  end

  # Build entity → risk severity map from wiki's risks page.
  def build_risk_map
    path = File.join(wiki_dir, RISKS_PAGE)
    return {} unless File.exist?(path)

    content = File.read(path, encoding: "UTF-8")
    map = {}
    current_severity = "MEDIUM"

    content.each_line do |line|
      if line.match?(/Severity:\s*(CRITICAL|HIGH|MEDIUM|LOW)/i)
        current_severity = line[/Severity:\s*(CRITICAL|HIGH|MEDIUM|LOW)/i, 1].upcase
      end
      line.scan(/`([A-Z]\w+)`/).flatten.each do |entity|
        existing = map[entity]
        map[entity] = current_severity if !existing || severity_rank(current_severity) > severity_rank(existing)
      end
    end

    map
  end

  def severity_rank(severity)
    case severity.to_s.upcase
    when "CRITICAL" then 4
    when "HIGH" then 3
    when "MEDIUM" then 2
    when "LOW" then 1
    else 0
    end
  end

  def write_evidence(evidence)
    review_dir = File.join(wiki_dir, "review")
    unless File.directory?(review_dir)
      $stderr.puts "Wiki bridge: SKIP (review/ directory not found in wiki)"
      return
    end

    output_path = File.join(wiki_dir, EVIDENCE_PATH)
    File.write(output_path, JSON.pretty_generate(evidence) + "\n")
    $stderr.puts "Wiki bridge: wrote #{EVIDENCE_PATH} (#{evidence['build_summary']['entities_confirmed']} entities, #{evidence['build_summary']['routes_confirmed']} routes)"

    commit_evidence(output_path)
  end

  def commit_evidence(output_path)
    return unless File.directory?(File.join(wiki_dir, ".git"))

    Dir.chdir(wiki_dir) do
      # Check for uncommitted changes (not ours)
      unless system("git", "diff", "--quiet", "HEAD", out: File::NULL, err: File::NULL)
        $stderr.puts "Wiki bridge: WARNING — wiki has uncommitted changes, skipping commit"
        $stderr.puts "  Run: cd #{wiki_dir} && git add review/build-evidence.json && git commit -m 'Build evidence from scaffold'"
        return
      end

      system("git", "add", "review/build-evidence.json")
      has_staged = !system("git", "diff", "--cached", "--quiet", out: File::NULL, err: File::NULL)
      if has_staged
        system("git", "commit", "-m", "Build evidence from scaffold\n\nGenerated by publish_to_wiki.rb post-build reconciliation.")
        $stderr.puts "Wiki bridge: committed build-evidence.json"
      end
    end
  end
end

# --- CLI ---

options = {}
OptionParser.new do |opts|
  opts.banner = "Usage: publish_to_wiki.rb [--wiki-dir DIR]"
  opts.on("--wiki-dir DIR", "Path to wiki root directory") { |v| options[:wiki_dir] = v }
end.parse!

# Auto-detect wiki_dir from config.yml if not provided
wiki_dir = options[:wiki_dir]
if wiki_dir.nil? || wiki_dir.empty?
  if File.exist?("config.yml")
    config = YAML.safe_load_file("config.yml", permitted_classes: [Symbol]) rescue {}
    wiki_dir = config.dig("wiki_bridge", "wiki_dir")
  end
end

if wiki_dir.nil? || wiki_dir.empty?
  $stderr.puts "Wiki bridge: no wiki_dir configured (pass --wiki-dir or set wiki_bridge.wiki_dir in config.yml)"
  exit 0
end

publisher = WikiPublisher.new(wiki_dir)
publisher.reconcile
