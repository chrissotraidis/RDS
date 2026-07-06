#!/usr/bin/env ruby
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

require "erb"
require "json"
require "optparse"
require "open3"
require "yaml"
require "fileutils"

options = { supporting_recipes: [], domains: [], debug_dir: nil, max_turns: 4 }
OptionParser.new do |opts|
  opts.banner = "Usage: generate_task_skeleton_chunks.rb --spec FILE --primary-recipe FILE --output FILE"
  opts.on("--spec FILE", "Specification file") { |v| options[:spec] = v }
  opts.on("--primary-recipe FILE", "Primary recipe YAML") { |v| options[:primary_recipe] = v }
  opts.on("--supporting-recipes LIST", "Comma-separated supporting recipe YAMLs") do |v|
    options[:supporting_recipes] = v.split(",").map(&:strip)
  end
  opts.on("--domains LIST", "Comma-separated domain type YAMLs") do |v|
    options[:domains] = v.split(",").map(&:strip)
  end
  opts.on("--output FILE", "Output raw JSON array path") { |v| options[:output] = v }
  opts.on("--debug-dir DIR", "Debug artifact directory") { |v| options[:debug_dir] = v }
  opts.on("--max-turns N", Integer, "Max turns per Claude call") { |v| options[:max_turns] = v }
end.parse!

%i[spec primary_recipe output].each do |key|
  abort "Missing --#{key.to_s.tr('_', '-')}" unless options[key]
end

def str(val)
  val.to_s.encode("UTF-8", invalid: :replace, undef: :replace)
end

def parse_spec_sections(text)
  sections = []
  current_heading = nil
  current_lines = []
  preamble = []
  seen_heading = false

  text.each_line do |line|
    if line.match?(/^##\s+[^#]/)
      if current_heading
        sections << { "heading" => current_heading, "body" => current_lines.join }
      elsif preamble.any? { |entry| !entry.strip.empty? }
        sections << { "heading" => "Overview", "body" => preamble.join }
      end

      seen_heading = true
      current_heading = line.sub(/^##\s+/, "").strip
      current_lines = [line]
    else
      if seen_heading
        current_lines << line
      else
        preamble << line
      end
    end
  end

  if current_heading
    sections <<({ "heading" => current_heading, "body" => current_lines.join })
  elsif preamble.any? { |entry| !entry.strip.empty? }
    sections <<({ "heading" => "Overview", "body" => preamble.join })
  end

  sections
end

def ignored_section?(heading)
  heading.to_s.match?(/\bfuture considerations\b|\bdeferred\b/i)
end

def build_chunks(sections, max_sections: 3, max_chars: 22_000)
  chunks = []
  current = []
  current_chars = 0

  sections.each do |section|
    next if ignored_section?(section["heading"])

    size = section["body"].to_s.length
    if current.any? && (current.length >= max_sections || current_chars + size > max_chars)
      chunks << current
      current = []
      current_chars = 0
    end

    current << section
    current_chars += size
  end

  chunks << current if current.any?
  chunks
end

def technology_context_for(primary_recipe, supporting_recipes, domains)
  parts = ["# Technology Context", ""]
  parts << "Recipe: #{str(primary_recipe["name"])} (#{str(primary_recipe["type"])})"
  parts << str(primary_recipe["description"]).strip if primary_recipe["description"]

  fw = primary_recipe["framework"]
  if fw && !fw.empty?
    parts << ""
    parts << "Framework stack:"
    fw.each { |key, value| parts << "- #{key}: #{value}" }
  end

  sections = (primary_recipe["sections"] || []).select { |entry| entry["phase"] == "pipeline" }
  sections.each do |section|
    parts << ""
    parts << "### #{section["name"]}"
    parts << section["description"]&.strip if section["description"]
    if section["solid_stack_setup"]
      parts << "Solid stack setup:"
      parts << section["solid_stack_setup"].strip
    end
  end

  if supporting_recipes.any?
    parts << ""
    parts << "## Supporting Recipes"
    supporting_recipes.each { |recipe| parts << "- #{recipe["name"]}: #{recipe["description"]&.strip}" }
  end

  if domains.any?
    parts << ""
    parts << "## Domain Context"
    domains.each do |domain|
      parts << "- #{domain["name"]}: #{domain["primary_value"]&.strip}"
    end
  end

  parts.join("\n")
end

def call_claude(prompt_data, max_turns)
  env = { "CLAUDE_CODE_MAX_OUTPUT_TOKENS" => "65536" }
  Open3.capture3(
    env,
    "claude", "-p",
    "--max-turns", max_turns.to_s,
    "--model", "sonnet",
    "--append-system-prompt", "Output ONLY a raw JSON array. No markdown, no tables, no prose, no commentary. Start with [ and end with ].",
    "--dangerously-skip-permissions",
    stdin_data: prompt_data
  )
end

def parse_json_array_response(response)
  text = response.to_s.strip

  begin
    envelope = JSON.parse(text)
    if envelope.is_a?(Hash) && envelope["type"] == "result" && envelope["result"]
      text = envelope["result"].to_s.strip
    end
  rescue JSON::ParserError
    # raw output
  end

  json_str =
    if text.start_with?("[")
      text
    elsif text.include?("```json")
      text[/```json\s*\n(.*?)```/m, 1]
    elsif text.include?("```")
      text[/```\s*\n(.*?)```/m, 1]
    elsif text.match?(/\[\s*\{/)
      text[text.index(/\[\s*\{/)..]
    else
      text
    end

  raise "empty response" if json_str.to_s.strip.empty?
  stripped = json_str.lstrip
  raise "mid-object output" unless stripped.start_with?("[")

  begin
    parsed = JSON.parse(stripped)
    raise "expected JSON array" unless parsed.is_a?(Array)
    return parsed
  rescue JSON::ParserError
    repaired = stripped.dup
    repaired.sub!(/,\s*\{[^}]*\z/, "")
    repaired.sub!(/,\s*"[^"]*\z/, "")
    open_braces = repaired.count("{") - repaired.count("}")
    open_brackets = repaired.count("[") - repaired.count("]")
    repaired += "]" * [open_brackets, 0].max
    repaired += "}" * [open_braces, 0].max
    parsed = JSON.parse(repaired)
    raise "expected JSON array" unless parsed.is_a?(Array)
    parsed
  end
end

def normalize_chunk_tasks(tasks, offset)
  ordered = tasks.sort_by { |task| task["position"].to_i }
  mapping = {}
  ordered.each_with_index do |task, idx|
    mapping[task["position"].to_i] = offset + idx
  end

  ordered.each_with_index do |task, idx|
    task["position"] = offset + idx
    task["priority"] = offset + idx
    task["depends_on"] = Array(task["depends_on"]).map { |dep| mapping.fetch(dep.to_i, dep.to_i) }.uniq
  end
  ordered
end

spec_text = File.read(options[:spec], encoding: "UTF-8")
primary_recipe = YAML.safe_load_file(options[:primary_recipe], permitted_classes: [Symbol])
supporting_recipes = options[:supporting_recipes].map { |path| YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path) }.compact
domains = options[:domains].map { |path| YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path) }.compact
technology_context = technology_context_for(primary_recipe, supporting_recipes, domains)

template_path = File.join(File.dirname(__FILE__), "..", "prompts", "task_skeleton_system.md.erb")
detail_template = ERB.new(File.read(template_path, encoding: "UTF-8"), trim_mode: "-")
system_prompt = detail_template.result(binding)

sections = parse_spec_sections(spec_text)
chunks = build_chunks(sections)
abort "No non-deferred spec sections found for chunked task generation" if chunks.empty?

debug_dir = options[:debug_dir]
FileUtils.mkdir_p(debug_dir) if debug_dir

generated = []

chunks.each_with_index do |chunk_sections, idx|
  offset = generated.size
  prior_summary = generated.last(15).map do |task|
    { position: task["position"], title: task["title"], section_ref: task["section_ref"], labels: task["labels"] }
  end
  chunk_context = chunk_sections.map { |section| "## #{section["heading"]}\n#{section["body"]}" }.join("\n\n")

  corrective_note = nil
  parsed_chunk = nil

  2.times do |attempt_idx|
    user_prompt = <<~PROMPT
      # Chunked Task Skeleton Generation

      Chunk #{idx + 1} of #{chunks.size}
      Position offset: #{offset}
      Section headings:
      #{chunk_sections.map { |section| "- #{section["heading"]}" }.join("\n")}

      Existing earlier tasks:
      ```json
      #{JSON.generate(prior_summary)}
      ```

      Relevant specification sections:

      #{chunk_context}

      Rules for this chunk:
      - Return ONLY task skeletons for the sections above.
      - Use absolute positions starting at #{offset}.
      - If offset is 0, include exactly one bootstrap task at position 0.
      - If offset is greater than 0, do NOT create another bootstrap task.
      - depends_on values must use absolute earlier positions or positions within this chunk.
      - When a task depends on earlier infrastructure, prefer depending on the most relevant task from the "Existing earlier tasks" list.
      - Keep tasks thin, vertically sliced, and independently executable.

      #{corrective_note}
    PROMPT

    prompt_data = "#{system_prompt}\n\n---\n\n#{user_prompt}"
    stdout, stderr, status = call_claude(prompt_data, options[:max_turns])
    raw_output = stdout.to_s
    if debug_dir
      File.write(File.join(debug_dir, format("task_generation_chunk_%02d_attempt_%02d.json.txt", idx + 1, attempt_idx + 1)), raw_output)
      File.write(File.join(debug_dir, format("task_generation_chunk_%02d_attempt_%02d.stderr.txt", idx + 1, attempt_idx + 1)), stderr.to_s)
    end

    begin
      parsed_chunk = normalize_chunk_tasks(parse_json_array_response(raw_output), offset)
      break
    rescue => e
      corrective_note = <<~NOTE
        Previous attempt failed: #{e.message}
        Return ONLY a valid raw JSON array beginning with `[` and ending with `]`.
      NOTE
      raise if attempt_idx == 1
    end
  end

  generated.concat(parsed_chunk)
end

File.write(options[:output], JSON.generate(generated))
