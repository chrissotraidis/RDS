#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# validate_tasks.rb — Task skeleton validator and v2 wrapper emitter
#
# Reads raw task JSON from stdin, validates structure, repairs dependency order,
# attaches deterministic workflow metadata derived from the spec, appends thin
# UAT/hygiene tasks, and emits tasks.json schema v2.
#
# Usage:
#   echo '[...]' | ruby lib/validate_tasks.rb > tasks.json
#   echo '[...]' | ruby lib/validate_tasks.rb --recipe-type web_app --spec spec.md > tasks.json

require "json"
require "optparse"
require "set"
require_relative "wiki_enricher"

SCHEMA_VERSION = 2
HYDRATION_MODE = "lazy"
METADATA_VERSION = 2
REQUIREMENT_REF_PATTERN = /\bREQ-[A-Z0-9-]+\b(?:#[A-Za-z0-9:_-]+)?/
REQUIREMENT_AUDIT_EXCLUSION_PATTERN = /\b(future considerations|deferred|testing strategy|test strategy)\b/i

ACTION_KEYWORDS = %w[
  click tap select submit send create edit update delete archive revoke
  invite export import view open navigate filter login logout register
  reset approve deny complete copy share
].freeze

EXPLICIT_UI_VERBS = %w[click tap open select submit].freeze
FIELD_SECTION_PATTERN = /\b(fields?|properties|attributes|schema|data model|object shape|models?|entities?|catalog)\b/i
RULE_SECTION_PATTERN = /\b(business|invariant|rule|rules|calculation|formula|acceptance criteria)\b/i
UI_CONTEXT_PATTERN = /\b(button|link|cta|tab|menu|navigation|nav|screen|page|view|title|label|placeholder|action|card)\b/i
GENERIC_ENTITY_HEADINGS = %w[overview requirements user journeys business rules rules entities models schema data model object shape].freeze

STOP_WORDS = %w[
  a an and are as at back by for from into of on or page screen tab task
  the to with your their this that then when given after before user coach
  client admin visitor member flow data route http app feature form button
].freeze

GENERIC_ACTION_TERMS = %w[
  view views navigate navigation create edit update filter manage open access
  click submit page screen list detail item items status statuses quick action actions
  correct pages user users record records data dashboard profile
].freeze

MAX_METADATA_ITEMS = 4

def classify_json_candidate(text, json_str)
  raw = text.to_s
  candidate = json_str.to_s
  stripped = candidate.lstrip

  return ["empty_output", "Claude returned an empty response."] if raw.strip.empty?
  return ["empty_extraction", "No JSON payload remained after extraction."] if stripped.empty?
  return ["mid_stream_fragment", "Task generation output was truncated before the JSON array start."] unless stripped.start_with?("[", "{")

  if stripped.start_with?("[")
    open_brackets = stripped.count("[")
    close_brackets = stripped.count("]")
    return ["tail_truncation", "JSON array appears truncated at the tail."] if close_brackets < open_brackets
    return ["array_candidate", "JSON array candidate detected."]
  end

  ["object_candidate", "JSON object candidate detected."]
end

def parse_input(input)
  text = input.to_s.force_encoding("UTF-8").strip

  begin
    envelope = JSON.parse(text)
    if envelope.is_a?(Hash) && envelope["type"] == "result" && envelope["result"]
      text = envelope["result"].force_encoding("UTF-8").strip
    end
  rescue JSON::ParserError
    # Not a Claude envelope
  end

  json_str = if text.start_with?("{", "[")
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

  abort "Could not extract JSON from input\nFailure kind: no_json_detected\nFirst 500 chars: #{text[0..500]}" unless json_str

  failure_kind, failure_message = classify_json_candidate(text, json_str)
  if failure_kind == "mid_stream_fragment"
    abort "#{failure_message}\nFailure kind: #{failure_kind}\nFirst 500 chars: #{json_str[0..500]}"
  end

  if json_str.lstrip.start_with?("[")
    depth = 0
    in_string = false
    escape_next = false
    end_idx = nil

    json_str.each_char.with_index do |char, idx|
      if escape_next
        escape_next = false
        next
      end

      if in_string && char == "\\"
        escape_next = true
        next
      end

      if char == '"'
        in_string = !in_string
        next
      end

      next if in_string

      if char == "["
        depth += 1
      elsif char == "]"
        depth -= 1
        if depth.zero?
          end_idx = idx
          break
        end
      end
    end

    json_str = json_str[0..end_idx] if end_idx
  end

  begin
    JSON.parse(json_str)
  rescue JSON::ParserError => e
    unless json_str.lstrip.start_with?("[", "{")
      abort "#{failure_message}\nFailure kind: #{failure_kind}\nFirst 500 chars: #{json_str[0..500]}"
    end

    if json_str.lstrip.start_with?("{")
      abort "Invalid JSON object payload: #{e.message}\nFailure kind: #{failure_kind}\nFirst 500 chars: #{json_str[0..500]}"
    end

    repaired = json_str.dup
    repaired.gsub!(/"(\w+)"\s*>/, '"\1":')
    repaired.sub!(/,\s*"[^"]*\z/, "")
    repaired.sub!(/,\s*\{[^}]*\z/, "")
    repaired.sub!(/,\s*\[[^\]]*\z/, "")

    open_braces = repaired.count("{") - repaired.count("}")
    open_brackets = repaired.count("[") - repaired.count("]")
    repaired += "]" * [open_brackets, 0].max
    repaired += "}" * [open_braces, 0].max

    begin
      JSON.parse(repaired)
    rescue JSON::ParserError
      abort "Invalid JSON (repair failed): #{e.message}\nFailure kind: #{failure_kind}\nFirst 500 chars: #{json_str[0..500]}"
    end
  end
end

def normalize_tasks(raw)
  case raw
  when Array
    raw
  when Hash
    if raw["schema_version"] && raw["tasks"].is_a?(Array)
      raw["tasks"]
    else
      raw["tasks"] || abort("Missing 'tasks' key in JSON")
    end
  else
    abort "Expected array of tasks, got #{raw.class}"
  end
end

def parse_spec_sections(text)
  sections = {}
  current_h2 = nil
  current_h3 = nil
  h2_body = []
  h3_body = []

  text.each_line do |line|
    if line.match?(/^##\s+[^#]/)
      if current_h3
        key = current_h2 ? "#{current_h2} > #{current_h3}" : current_h3
        sections[key] = h3_body.join
      end
      sections[current_h2] = h2_body.join if current_h2

      current_h2 = line.sub(/^##\s+/, "").strip
      current_h3 = nil
      h2_body = [line]
      h3_body = []
    elsif line.match?(/^###\s+/)
      if current_h3
        key = current_h2 ? "#{current_h2} > #{current_h3}" : current_h3
        sections[key] = h3_body.join
      end

      current_h3 = line.sub(/^###\s+/, "").strip
      h3_body = [line]
      h2_body << line
    else
      h2_body << line
      h3_body << line if current_h3
    end
  end

  if current_h3
    key = current_h2 ? "#{current_h2} > #{current_h3}" : current_h3
    sections[key] = h3_body.join
  end
  sections[current_h2] = h2_body.join if current_h2

  preamble = text.split(/^##\s+[^#]/).first
  sections["Overview"] = preamble if preamble && !preamble.strip.empty?
  sections
end

def find_matching_sections(section_ref, spec_sections)
  return {} if section_ref.to_s.strip.empty?

  ref_lower = section_ref.downcase.strip
  exact = spec_sections.select { |heading, _| heading.to_s.downcase == ref_lower }
  return exact unless exact.empty?

  parts = ref_lower.split(/\s*>\s*/).map(&:strip)
  partial = spec_sections.select do |heading, _|
    heading_lower = heading.to_s.downcase
    parts.any? { |part| heading_lower.include?(part) }
  end
  return partial unless partial.empty?

  ref_words = ref_lower.split(/\W+/).reject { |word| word.length < 3 }
  spec_sections.select do |heading, _|
    heading_words = heading.to_s.downcase.split(/\W+/)
    (ref_words & heading_words).any?
  end
end

def parse_table_row(line)
  stripped = line.to_s.strip
  return [] unless stripped.start_with?("|")

  stripped.sub(/\A\|/, "").sub(/\|\z/, "").split("|").map { |cell| cell.strip }
end

def table_separator?(line)
  line.to_s.strip.match?(/\A\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\z/)
end

def field_section_heading?(heading)
  heading.to_s.match?(FIELD_SECTION_PATTERN)
end

def rule_section_heading?(heading)
  heading.to_s.match?(RULE_SECTION_PATTERN)
end

def canonical_entity_name(raw)
  heading = raw.to_s.gsub(/[`*_]/, "").split(":").first.to_s.strip
  return nil if heading.empty?
  return nil if field_section_heading?(heading) || rule_section_heading?(heading)

  words = heading.scan(/[A-Za-z][A-Za-z0-9_]*/)
  return nil if words.empty? || words.size > 4

  normalized = words.map { |word| singularize(word) }
  return nil if normalized.map(&:downcase).all? { |word| GENERIC_ENTITY_HEADINGS.include?(word.downcase) }

  normalized.map { |word| word[0].upcase + word[1..].to_s }.join
end

def field_like_label?(label)
  cleaned = label.to_s.gsub(/[`*_]/, "").strip
  return false if cleaned.empty? || cleaned.length > 48
  return false if cleaned.match?(/[+%=<>]/)

  words = cleaned.scan(/[A-Za-z][A-Za-z0-9_-]*/)
  return false if words.empty? || words.size > 5

  generic = %w[description details examples behavior validation note notes rules constraints]
  words.any? { |word| !generic.include?(word.downcase) }
end

def add_contract_field(contract, field, remainder = "")
  clean_field = field.to_s.gsub(/[`*_]/, "").strip
  return if clean_field.empty?

  normalized = clean_field.downcase
  contract["required_fields"] << clean_field if remainder.match?(/\brequired\b|\bmust\b|\bpresent\b|\bnot null\b/)
  contract["foreign_keys"] << clean_field if normalized.end_with?("_id") || remainder.match?(/\bbelongs to\b|\breferences\b/)
  contract["lifecycle_fields"] << clean_field if normalized.match?(/(archived|deleted|deactivated|expires|revoked|closed|completed|sent|locked)_at$/)
  contract["unique_constraints"] << [clean_field] if remainder.match?(/\bunique\b|\buniqueness\b/)
  contract["mutable"] = false if remainder.match?(/\bimmutable\b|\bread-only\b|\bread only\b/)
end

def normalize_contract(contract)
  contract["required_fields"].uniq!
  contract["foreign_keys"].uniq!
  contract["lifecycle_fields"].uniq!
  contract["sensitive_events"].uniq!
  contract["unique_constraints"] = contract["unique_constraints"]
    .map { |group| Array(group).map(&:to_s).uniq }
    .reject(&:empty?)
    .uniq
  contract
end

def extract_entity_contracts(spec_text)
  contracts = {}
  current_h2 = nil
  current_h3 = nil
  in_entity_area = false
  lines = spec_text.each_line.to_a
  i = 0

  while i < lines.length
    stripped = lines[i].strip

    if stripped.match?(/^##\s+/)
      current_h2 = stripped.sub(/^##\s+/, "").strip
      current_h3 = nil
      in_entity_area = current_h2.match?(FIELD_SECTION_PATTERN)
      i += 1
      next
    end

    if stripped.match?(/^###\s+/)
      current_h3 = stripped.sub(/^###\s+/, "").strip
      in_entity_area ||= current_h3.match?(FIELD_SECTION_PATTERN)
      i += 1
      next
    end

    current_entity =
      if in_entity_area
        canonical_entity_name(current_h3) || canonical_entity_name(current_h2)
      end

    unless current_entity
      i += 1
      next
    end

    contracts[current_entity] ||= {
      "required_fields" => [],
      "unique_constraints" => [],
      "foreign_keys" => [],
      "lifecycle_fields" => [],
      "mutable" => true,
      "sensitive_events" => []
    }
    contract = contracts[current_entity]

    if stripped.start_with?("|") && table_separator?(lines[i + 1])
      headers = parse_table_row(lines[i]).map(&:downcase)
      field_idx = headers.index { |header| header.match?(/\b(field|property|attribute|column|name|key)\b/) } || 0
      i += 2

      while i < lines.length && lines[i].strip.start_with?("|")
        cells = parse_table_row(lines[i])
        label = cells[field_idx].to_s
        details = cells.join(" ").downcase
        add_contract_field(contract, label, details) if field_like_label?(label)
        i += 1
      end
      next
    end

    quoted_fields = stripped.scan(/`([\w_]+)`/).flatten

    if (match = stripped.match(/^[*-]\s*`([\w_]+)`(.*)$/))
      add_contract_field(contract, match[1], match[2].downcase)
    elsif (match = stripped.match(/^(?:[-*]\s*)?(?:\*\*|__)?([A-Za-z][A-Za-z0-9_\/() -]{1,40})(?:\*\*|__)?\s*:\s+(.+)$/))
      label = match[1].strip
      add_contract_field(contract, label, match[2].downcase) if field_like_label?(label)
    elsif field_section_heading?(current_h2) || field_section_heading?(current_h3)
      if (match = stripped.match(/^(?:[-*]\s*)?(?:\*\*|__)?([A-Za-z][A-Za-z0-9_\/() -]{1,40})(?:\*\*|__)?$/))
        label = match[1].strip
        add_contract_field(contract, label, "") if field_like_label?(label)
      end
    end

    if stripped.match?(/\bunique\b/i)
      fields = quoted_fields.uniq
      contract["unique_constraints"] << fields if fields.any?
    end

    quoted_fields.each do |field|
      contract["foreign_keys"] << field if field.end_with?("_id")
      contract["lifecycle_fields"] << field if field.match?(/(archived|deleted|deactivated|expires|revoked|closed|completed|sent|locked)_at$/)
    end

    if stripped.match?(/\baudit|log|sensitive action|security/i)
      contract["sensitive_events"] << stripped.gsub(/^[-*]\s*/, "")
    end

    i += 1
  end

  contracts.transform_values { |contract| normalize_contract(contract) }
end

def extract_action_catalog(spec_text)
  actions = []

  spec_text.each_line do |line|
    stripped = line.strip
    next if stripped.empty?
    next unless stripped.match?(/\b(?:#{ACTION_KEYWORDS.join("|")})\b/i)

    labels = stripped.scan(/["“]([^"”]{2,80})["”]/).flatten
    labels += stripped.scan(/`([^`]{2,80})`/).flatten
    actions << {
      "text" => stripped,
      "labels" => labels.uniq.first(4)
    }
  end

  actions.first(150)
end

def extract_operational_prerequisites(spec_text)
  prereqs = {}
  text = spec_text.downcase

  prereqs["local_http_server"] = "A local HTTP server or entry point must run for user-visible flows." if text.match?(/\b(route|page|screen|dashboard|portal|http|localhost|browser)\b/)
  prereqs["seed_data_loaded"] = "Seed or fixture data must load before user-journey verification." if text.match?(/\bseed|fixture|demo data|example\.com|test user|sample data\b/)
  prereqs["background_processing_ready"] = "Async jobs, workers, queues, or in-process fallbacks must execute locally before dependent features pass." if text.match?(/\b(background|queue|worker|async|job|scheduled|scheduler|cron|deliver_later|perform_later)\b/)
  prereqs["email_delivery_ready"] = "Local email delivery must be visible or inspectable in development before email features pass." if text.match?(/\bemail|mailer|smtp|letter opener|password reset|invitation\b/)
  prereqs["scheduler_ready"] = "Recurring tasks need a local scheduler or deterministic fallback." if text.match?(/\brecurring|schedule|scheduler|cron|daily|hourly\b/)
  prereqs["authenticated_seed_account"] = "At least one seeded credentialed account must exist for protected-flow verification." if text.match?(/\blogin|log in|register|sign in|password|session|authenticate\b/)

  prereqs
end

def extract_requirement_refs(text)
  text.to_s.scan(REQUIREMENT_REF_PATTERN).uniq
end

def infer_requirement_refs(task, matched_sections)
  explicit = Array(task["requirement_refs"]).map(&:to_s).map(&:strip).reject(&:empty?)
  return explicit.uniq if explicit.any?

  section_refs = matched_sections.keys.flat_map { |heading| extract_requirement_refs(heading) }.uniq
  return section_refs if section_refs.size == 1

  body_refs = matched_sections.values.join("\n").scan(REQUIREMENT_REF_PATTERN).uniq
  body_refs.size == 1 ? body_refs : []
end

def active_requirement_refs(spec_sections)
  spec_sections.each_with_object(Set.new) do |(heading, body), refs|
    next if heading.to_s.match?(REQUIREMENT_AUDIT_EXCLUSION_PATTERN)

    extract_requirement_refs("#{heading}\n#{body}").each { |ref| refs << ref }
  end
end

def requirement_audit_exempt_task?(task)
  title = task["title"].to_s
  title.match?(/UAT Walkthrough|Final Hygiene Check/i)
end

def audit_requirement_coverage!(tasks, spec_sections)
  active_refs = active_requirement_refs(spec_sections)
  return { "active_requirement_refs" => [], "covered_requirement_refs" => [] } if active_refs.empty?

  covered_refs = tasks.each_with_object(Set.new) do |task, refs|
    next if requirement_audit_exempt_task?(task)

    Array(task["requirement_refs"]).each do |ref|
      normalized = ref.to_s.strip
      refs << normalized unless normalized.empty?
    end
  end

  missing_refs = active_refs - covered_refs
  unless missing_refs.empty?
    abort "Requirement coverage audit failed: #{missing_refs.size} active requirement ref(s) are not owned by any task: #{missing_refs.to_a.sort.join(', ')}"
  end

  {
    "active_requirement_refs" => active_refs.to_a.sort,
    "covered_requirement_refs" => covered_refs.to_a.sort
  }
end

def singularize(word)
  return word[0..-4] + "y" if word.end_with?("ies") && word.length > 4
  return word[0..-2] if word.end_with?("s") && !word.end_with?("ss")

  word
end

def frontend_like?(task, section_text)
  labels = (task["labels"] || []).map(&:downcase)
  text = [task["title"], task["section_ref"], task["user_story"], task["done_when"], section_text].compact.join(" ").downcase
  return true if (labels & %w[frontend ui views ios android flutter]).any?

  text.match?(/\b(page|screen|view|layout|dashboard|portal|profile|settings|report|form|nav|tab|button|link)\b/)
end

def infer_capabilities(task, section_text)
  labels = (task["labels"] || []).map(&:downcase)
  text = [task["title"], task["section_ref"], task["user_story"], task["done_when"]].compact.join(" ").downcase
  caps = []

  caps << "browser_ui" if frontend_like?(task, section_text) && !(labels & %w[ios android flutter]).any?
  caps << "http_routes" if text.match?(/\b(get|post|patch|put|delete)\s+\/|endpoint|route|path|api\b/) || (caps.include?("browser_ui") && labels.include?("backend"))
  caps << "background_work" if text.match?(/\b(background|queue|worker|async|job|scheduled|scheduler|cron|import|export)\b/)
  caps << "email_delivery" if text.match?(/\b(email|mailer|smtp|password reset|invitation|welcome email|notification email)\b/)
  caps << "authn" if text.match?(/\b(login|log in|logout|sign up|register|password|session|authentication)\b/)
  caps << "authz" if text.match?(/\b(role|permission|authorization|access control|forbidden|admin only|coach only|client only|rbac)\b/)
  caps << "seed_data" if !task["title"].to_s.match?(/UAT Walkthrough|Final Hygiene Check/i) &&
    (text.match?(/\bseed|fixture|demo data|sample data|test user\b/) || labels.include?("database") || caps.any? { |cap| %w[browser_ui authn authz].include?(cap) })
  caps << "accessibility" if caps.include?("browser_ui") || (labels & %w[ios android flutter]).any?
  caps << "native_tests" unless task["title"].to_s.match?(/UAT Walkthrough|Final Hygiene Check/i)

  caps.uniq.first(MAX_METADATA_ITEMS + 2)
end

def infer_entities_touched(task, section_text, entity_contracts)
  text = [task["title"], task["section_ref"], task["user_story"], task["done_when"]].compact.join(" ").downcase
  entities = entity_contracts.keys.select do |entity|
    forms = [entity.downcase, entity.downcase.gsub("_", " "), "#{entity.downcase}s", singularize(entity.downcase)]
    forms.any? { |term| text.include?(term) }
  end

  entities << "User" if entities.empty? && text.match?(/\buser|account|login|session|registration|password\b/)
  entities << "AuditLog" if text.match?(/\baudit\b/)
  entities.uniq.first(MAX_METADATA_ITEMS)
end

def compact_action_terms(terms, allow_generic: false)
  terms
    .map { |term| singularize(term.downcase) }
    .reject do |term|
      STOP_WORDS.include?(term) || (!allow_generic && GENERIC_ACTION_TERMS.include?(term))
    end
    .uniq
    .first(3)
end

def explicit_ui_labels(text)
  return [] if text.to_s.strip.empty?

  text.to_s.each_line.flat_map do |line|
    next [] unless line.match?(UI_CONTEXT_PATTERN)

    labels = line.scan(/["“]([^"”]{1,60})["”]/).flatten
    # Backtick contents are conventionally code in Markdown (e.g.
    # `Rails.env.development?`, `invited`, `status=complete`). Accept only
    # those that look like human-readable labels — no code-shaped chars.
    line.scan(/`([^`]{1,60})`/).flatten.each do |snippet|
      labels << snippet unless snippet.match?(/[.?!=]|::|\(\)/)
    end
    labels.select do |label|
      normalized = compact_action_terms(label.scan(/\b[a-z][a-z0-9_]{2,}\b/i))
      normalized.any?
    end
  end
end

def route_or_screen_phrases(task)
  phrases = []
  sources = [task["title"], task["section_ref"], task["done_when"]].compact
  implementation_verbs = %w[build implement create add update design render wire scaffold tapping clicking opening selecting submitting]

  sources.each do |source|
    source.to_s.scan(%r{/[a-z0-9_/:.-]+}i).each do |path|
      segments = path.split("/").reject(&:empty?).reject { |segment| segment.start_with?(":") || segment.match?(/^\d+$/) }
      next if segments.empty?

      phrase = compact_action_terms(segments.last(2).map { |segment| segment.tr("_-", " ") }.join(" ").scan(/\b[a-z][a-z0-9_]{2,}\b/i))
      phrases << phrase.join(" ") if phrase.any?
    end

    source.to_s.scan(/\b([A-Za-z][A-Za-z0-9 ]{1,40})\s+(page|screen|view|form|tab|menu|nav|navigation|card)\b/i).each do |subject, kind|
      phrase = compact_action_terms("#{subject} #{kind}".scan(/\b[a-z][a-z0-9_]{2,}\b/i), allow_generic: true)
        .reject { |term| implementation_verbs.include?(term) }
      phrases << phrase.join(" ") if phrase.any?
    end
  end

  phrases
end

def infer_ui_actions(task, section_text)
  text = [task["user_story"], task["done_when"]].compact.join(" ")
  actions = []

  explicit_ui_labels([task["user_story"], task["done_when"], section_text].compact.join("\n")).each do |label|
    terms = compact_action_terms(label.scan(/\b[a-z][a-z0-9_]{2,}\b/i))
    actions << terms.join(" ") if terms.any?
  end

  route_or_screen_phrases(task).each { |phrase| actions << phrase unless phrase.empty? }

  text.scan(/\b(#{EXPLICIT_UI_VERBS.join("|")})\b(?:\s+(?:the|a|an))?\s+([^.,;\n]+)/i).each do |verb, target|
    target_terms = compact_action_terms(target.scan(/\b[a-z][a-z0-9_]{2,}\b/i))
    next if target_terms.empty?

    actions << ([verb.downcase] + target_terms).join(" ")
  end

  actions.reject(&:empty?).uniq.first(MAX_METADATA_ITEMS)
end

def infer_sensitive_events(task, section_text)
  text = [task["title"], task["section_ref"], task["user_story"], task["done_when"]].compact.join(" ").downcase
  events = []
  events << "authentication" if text.match?(/\b(login|logout|register|password reset|password|session)\b/)
  events << "authorization" if text.match?(/\b(permission|authorization|forbidden|access control|rbac)\b/)
  events << "account_change" if text.match?(/\b(account|settings|profile|privacy|export|delete|archive|closure)\b/)
  events << "data_access" if text.match?(/\b(private data|download|export|survey report|client portal|shared data)\b/)
  events << "invitation" if text.match?(/\binvitation|invite\b/)
  events.uniq
end

def infer_operational_prereqs(task, capabilities, global_prereqs, section_text)
  text = [task["title"], task["section_ref"], task["user_story"], task["done_when"], section_text].compact.join(" ").downcase
  prereqs = []
  prereqs << "local_http_server" if (capabilities & %w[browser_ui http_routes]).any? && global_prereqs.key?("local_http_server")
  prereqs << "seed_data_loaded" if capabilities.include?("seed_data") && global_prereqs.key?("seed_data_loaded")
  prereqs << "background_processing_ready" if (capabilities & %w[background_work email_delivery]).any? && global_prereqs.key?("background_processing_ready")
  prereqs << "email_delivery_ready" if capabilities.include?("email_delivery") && global_prereqs.key?("email_delivery_ready")
  prereqs << "scheduler_ready" if text.match?(/\brecurring|schedule|scheduler|cron|daily|hourly\b/) && global_prereqs.key?("scheduler_ready")
  prereqs << "authenticated_seed_account" if (capabilities & %w[authn authz]).any? && global_prereqs.key?("authenticated_seed_account")
  prereqs.uniq
end

def repair_dependency_order(tasks)
  positions = tasks.map { |task| task["position"] }.to_set
  tasks.each do |task|
    task["depends_on"] = (task["depends_on"] || []).select { |dep| positions.include?(dep) }
  end

  needs_reorder = tasks.any? do |task|
    task["depends_on"].any? { |dep| dep >= task["position"] }
  end
  return unless needs_reorder

  $stderr.puts "Warning: Repairing task dependency order via topological sort"

  in_degree = {}
  tasks.each { |task| in_degree[task["position"]] = 0 }
  tasks.each do |task|
    task["depends_on"].each { in_degree[task["position"]] += 1 }
  end

  queue = tasks.select { |task| in_degree[task["position"]].zero? }.sort_by { |task| task["position"] }
  sorted = []

  until queue.empty?
    task = queue.shift
    sorted << task

    tasks.each do |other|
      next unless other["depends_on"].include?(task["position"])

      in_degree[other["position"]] -= 1
      queue << other if in_degree[other["position"]].zero?
    end
    queue.sort_by! { |candidate| candidate["position"] }
  end

  if sorted.size < tasks.size
    $stderr.puts "Warning: Dependency cycle detected, stripping circular dependencies"
    tasks.each { |task| task["depends_on"] = [] }
    return
  end

  pos_map = {}
  sorted.each_with_index { |task, idx| pos_map[task["position"]] = idx }
  sorted.each_with_index do |task, idx|
    task["depends_on"] = task["depends_on"].map { |dep| pos_map[dep] }
    task["position"] = idx
  end
  tasks.replace(sorted)
end

def renumber_tasks!(tasks)
  pos_map = tasks.each_with_index.to_h { |task, idx| [task["position"], idx] }

  tasks.each_with_index do |task, idx|
    task["depends_on"] = (task["depends_on"] || []).filter_map { |dep| pos_map[dep] }.uniq
    task["position"] = idx
    task["priority"] = idx
  end
end

def make_thin_task(attrs)
  {
    "title" => attrs.fetch(:title),
    "position" => attrs.fetch(:position),
    "depends_on" => attrs.fetch(:depends_on),
    "labels" => attrs.fetch(:labels),
    "section_ref" => attrs.fetch(:section_ref, ""),
    "user_story" => attrs.fetch(:user_story, ""),
    "done_when" => attrs.fetch(:done_when, ""),
    "requirement_refs" => attrs.fetch(:requirement_refs, []),
    "capabilities_required" => attrs.fetch(:capabilities_required, []),
    "entities_touched" => attrs.fetch(:entities_touched, []),
    "ui_actions" => attrs.fetch(:ui_actions, []),
    "sensitive_events" => attrs.fetch(:sensitive_events, []),
    "operational_prerequisites" => attrs.fetch(:operational_prerequisites, []),
    "priority" => attrs.fetch(:priority),
    "status" => "pending"
  }
end

options = {}
OptionParser.new do |opts|
  opts.banner = "Usage: validate_tasks.rb [--recipe-type TYPE] [--spec FILE] [--wiki DIR] [--context FILE] [--max-tasks N]"
  opts.on("--recipe-type TYPE", "Primary recipe type") { |v| options[:recipe_type] = v }
  opts.on("--spec FILE", "Spec path for metadata extraction") { |v| options[:spec] = v }
  opts.on("--wiki DIR", "Wiki directory for enrichment (entity names, routes, risks)") { |v| options[:wiki] = v }
  opts.on("--context FILE", "Arnold context JSON for stack detection") { |v| options[:context] = v }
  opts.on("--max-tasks N", Integer, "Maximum generated implementation tasks before validator-appended tasks") { |v| options[:max_tasks] = v }
end.parse!(ARGV)

recipe_type = options[:recipe_type]
spec_text = options[:spec] && File.exist?(options[:spec]) ? File.read(options[:spec], encoding: "UTF-8") : ""
wiki_enricher = options[:wiki] ? WikiEnricher.new(options[:wiki]) : nil
context_json = if options[:context] && File.exist?(options[:context])
  begin
    JSON.parse(File.read(options[:context], encoding: "UTF-8"))
  rescue JSON::ParserError
    $stderr.puts "Warning: Could not parse context JSON: #{options[:context]}"
    nil
  end
end
spec_sections = spec_text.empty? ? {} : parse_spec_sections(spec_text)
entity_contracts = spec_text.empty? ? {} : extract_entity_contracts(spec_text)
action_catalog = spec_text.empty? ? [] : extract_action_catalog(spec_text)
global_prereqs = spec_text.empty? ? {} : extract_operational_prerequisites(spec_text)

raw = parse_input($stdin.read)
tasks = normalize_tasks(raw)
abort "No tasks generated" if tasks.empty?

if options[:max_tasks] && tasks.size > options[:max_tasks]
  $stderr.puts "ERROR: Generated #{tasks.size} implementation tasks; hard budget is #{options[:max_tasks]}."
  $stderr.puts "Consolidate related work into larger vertical slices before UAT/hygiene."
  abort "Failure kind: task_budget_exceeded"
end

tasks.each_with_index do |task, idx|
  abort "Task #{idx} missing 'title'" unless task["title"]
  abort "Task #{idx} missing 'position'" unless task["position"]

  task["depends_on"] ||= []
  task["labels"] ||= []
  task["section_ref"] ||= ""
  task["user_story"] ||= ""
  task["done_when"] ||= ""
  task["requirement_refs"] ||= []
  task["capabilities_required"] ||= []
  task["entities_touched"] ||= []
  task["ui_actions"] ||= []
  task["sensitive_events"] ||= []
  task["operational_prerequisites"] ||= []
  task["priority"] ||= task["position"]
  task["status"] = "pending"

  if task["done_when"].to_s.strip.empty?
    $stderr.puts "ERROR: Task #{task["position"]} (#{task["title"]}) has empty done_when. Every task must have a behavior contract."
    abort "Failure kind: missing_done_when"
  end
  if task["user_story"].to_s.strip.empty?
    $stderr.puts "Warning: Task #{task["position"]} (#{task["title"]}) has empty user_story"
  end
end

tasks.map! do |task|
  matched_sections = find_matching_sections(task["section_ref"], spec_sections)
  section_text = matched_sections.values.join("\n\n")
  capabilities = infer_capabilities(task, section_text)
  requirement_refs = infer_requirement_refs(task, matched_sections)
  entities = infer_entities_touched(task, section_text, entity_contracts)
  ui_actions = infer_ui_actions(task, section_text)
  sensitive_events = infer_sensitive_events(task, section_text)
  operational_prereqs = infer_operational_prereqs(task, capabilities, global_prereqs, section_text)

  make_thin_task(
    title: task["title"],
    position: task["position"],
    depends_on: task["depends_on"],
    labels: task["labels"],
    section_ref: task["section_ref"],
    user_story: task["user_story"],
    done_when: task["done_when"],
    requirement_refs: requirement_refs,
    capabilities_required: (task["capabilities_required"] + capabilities).uniq,
    entities_touched: (task["entities_touched"] + entities).uniq,
    ui_actions: (task["ui_actions"] + ui_actions).uniq,
    sensitive_events: (task["sensitive_events"] + sensitive_events).uniq,
    operational_prerequisites: (task["operational_prerequisites"] + operational_prereqs).uniq,
    priority: task["priority"]
  )
end

repair_dependency_order(tasks)
tasks.sort_by! { |task| task["position"] }

# Risk-informed reordering: within each dependency tier, promote tasks that
# touch CRITICAL/HIGH risk entities. Pass 1 is topological sort (already done
# by repair_dependency_order). Pass 2 re-ranks within tied positions.
if wiki_enricher
  risk_severity_map = wiki_enricher.risk_map
  unless risk_severity_map.empty?
    severity_order = { "CRITICAL" => 0, "HIGH" => 1, "MEDIUM" => 2, "LOW" => 3 }

    # Group tasks by their deepest dependency depth (tier)
    depth_cache = {}
    calc_depth = ->(task) do
      return depth_cache[task["position"]] if depth_cache.key?(task["position"])
      deps = task["depends_on"] || []
      if deps.empty?
        depth_cache[task["position"]] = 0
      else
        dep_tasks = deps.filter_map { |pos| tasks.find { |t| t["position"] == pos } }
        depth_cache[task["position"]] = dep_tasks.map { |dt| calc_depth.call(dt) }.max.to_i + 1
      end
    end
    tasks.each { |t| calc_depth.call(t) }

    # Within each depth tier, sort by risk severity (CRITICAL first)
    tasks.sort_by! do |task|
      entities = task["entities_touched"] || []
      worst_severity = entities.map { |e| risk_severity_map[e] }.compact
        .min_by { |s| severity_order[s] || 99 }
      risk_rank = severity_order[worst_severity] || 99
      [depth_cache[task["position"]] || 0, risk_rank, task["position"]]
    end

    renumber_tasks!(tasks)

    $stderr.puts "Applied risk-informed reordering (#{risk_severity_map.size} entities with risk data)"
  end
end

if tasks.first && tasks.first["position"] != 0
  $stderr.puts "Warning: No task at position 0 (bootstrap). Renumbering."
  renumber_tasks!(tasks)
end

has_uat = tasks.any? { |task| task["title"].downcase.match?(/uat|walkthrough|acceptance|smoke.*test|end.to.end/) }
unless has_uat
  last_pos = tasks.last["position"]
  project_type = recipe_type
  unless project_type
    labels = tasks.flat_map { |task| task["labels"] || [] }.uniq
    project_type =
      if (labels & %w[ios android flutter]).any?
        "mobile_app"
      elsif labels.include?("frontend")
        "web_app"
      else
        "generic"
      end
  end

  user_story, done_when, labels =
    case project_type
    when "web_app", "landing_page"
      [
        "As a user, I can navigate every major screen and each primary interaction works with seeded data.",
        "Every major linked page returns success and the primary user journeys from the spec complete end-to-end with seeded data.",
        %w[testing frontend integration]
      ]
    when "api_service", "bot_agent"
      [
        "As an integrator, I can call each primary endpoint and receive valid responses with seeded data.",
        "All primary endpoints return success and the main journeys described in the spec work end-to-end with seeded data.",
        %w[testing backend integration]
      ]
    when "mobile_app"
      [
        "As a mobile user, the app contract is complete and the primary flows are supported by seeded backend data.",
        "Native compilation succeeds and all primary backend contracts needed for the app return success with seeded data.",
        %w[testing integration]
      ]
    else
      [
        "As a user, I can complete the primary flows described in the spec.",
        "The primary user journeys from the spec work end-to-end with seeded data and required validation passes.",
        %w[testing integration]
      ]
    end

  tasks << make_thin_task(
    title: "UAT Walkthrough",
    position: last_pos + 1,
    depends_on: [last_pos],
    labels: labels,
    section_ref: "User Journeys",
    user_story: user_story,
    done_when: done_when,
    requirement_refs: [],
    capabilities_required: %w[native_tests seed_data],
    entities_touched: [],
    ui_actions: ["complete primary flows"],
    sensitive_events: [],
    operational_prerequisites: global_prereqs.keys & %w[local_http_server seed_data_loaded authenticated_seed_account],
    priority: last_pos + 1
  )
  $stderr.puts "Appended 'UAT Walkthrough' task at position #{last_pos + 1}"
end

has_hygiene = tasks.any? { |task| task["title"].downcase.match?(/hygiene|cleanup|final.*check/) }
unless has_hygiene
  last_pos = tasks.last["position"]
  tasks << make_thin_task(
    title: "Final Hygiene Check",
    position: last_pos + 1,
    depends_on: [last_pos],
    labels: ["hygiene"],
    section_ref: "",
    user_story: "As a developer, I verify the project is clean, documented, and ready to ship.",
    done_when: "All global verification passes, project docs are usable, and no generated artifacts are left untracked.",
    requirement_refs: [],
    capabilities_required: [],
    entities_touched: [],
    ui_actions: [],
    sensitive_events: [],
    operational_prerequisites: [],
    priority: last_pos + 1
  )
  $stderr.puts "Appended 'Final Hygiene Check' task at position #{last_pos + 1}"
end

$stderr.puts "Validated #{tasks.size} tasks"
if tasks.size < 3
  $stderr.puts "Warning: Very few tasks generated (#{tasks.size}). Consider whether the spec is detailed enough."
elsif tasks.size > 50
  $stderr.puts "Warning: Many tasks generated (#{tasks.size}). Consider whether granularity is appropriate."
end

requirement_audit = spec_sections.empty? ? { "active_requirement_refs" => [], "covered_requirement_refs" => [] } : audit_requirement_coverage!(tasks, spec_sections)

wiki_metadata = if wiki_enricher
  enrichment = wiki_enricher.enrich
  {
    "wiki_dir" => options[:wiki],
    "entities_discovered" => enrichment[:entities].keys,
    "routes_discovered" => enrichment[:routes].size,
    "risks_discovered" => enrichment[:risks].size,
    "triage_present" => !enrichment[:triage].nil?
  }
end

context_metadata = if context_json
  {
    "context_file" => options[:context],
    "stack" => context_json.dig("stack", "framework") || context_json.dig("stack", "language"),
    "confidence" => context_json.dig("stack", "confidence")
  }
end

doc = {
  "schema_version" => SCHEMA_VERSION,
  "hydration_mode" => HYDRATION_MODE,
  "metadata_version" => METADATA_VERSION,
  # Sync baseline — resolved lazily by bin/task sync to the first commit
  # that introduced spec.md. Replaced with a real git SHA after the first
  # successful `bin/task sync --apply`. Keeping the sentinel here avoids a
  # chicken-and-egg commit-then-amend dance during the initial scaffold run.
  "last_synced_spec_sha" => "baseline",
  "spec_metadata" => {
    "entity_contracts" => entity_contracts,
    "action_catalog" => action_catalog,
    "operational_prerequisites" => global_prereqs,
    "requirement_audit" => requirement_audit
  },
  "wiki_metadata" => wiki_metadata,
  "context_metadata" => context_metadata,
  "tasks" => tasks
}.compact

$stdout.write(JSON.pretty_generate(doc).encode("UTF-8", invalid: :replace, undef: :replace) + "\n")
