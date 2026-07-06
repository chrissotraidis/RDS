#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

# wiki_enricher.rb — Extract enrichment data from a product wiki
#
# Reads wiki pages produced by wiki analysis and extracts structured
# data that supplements the spec for task generation:
#   - Real entity/column names from engineering/data-and-entities.md
#   - Real routes/endpoints from engineering/interfaces-and-integrations.md
#   - Risk severity from operations/risks-and-known-gaps.md
#   - Migration triage decisions from review/migration-triage.yml (if present)
#
# Usage:
#   enrichment = WikiEnricher.new(wiki_dir).enrich
#   # => { entities: {...}, routes: [...], risks: [...], triage: {...} }

require "yaml"

class WikiEnricher
  ENTITY_PAGE = "engineering/data-and-entities.md"
  ROUTES_PAGE = "engineering/interfaces-and-integrations.md"
  RISKS_PAGE  = "operations/risks-and-known-gaps.md"
  TRIAGE_FILE = "review/migration-triage.yml"

  attr_reader :wiki_dir

  def initialize(wiki_dir)
    @wiki_dir = wiki_dir
  end

  # Returns a hash with all enrichment data, or empty sections if wiki is missing.
  def enrich
    return empty_enrichment unless File.directory?(wiki_dir)

    {
      entities: extract_entities,
      routes: extract_routes,
      risks: extract_risks,
      triage: extract_triage
    }
  end

  # Format enrichment data as prompt context for task generation.
  def to_prompt_context
    data = enrich
    sections = []

    if data[:entities].any?
      sections << format_entities_context(data[:entities])
    end

    if data[:routes].any?
      sections << format_routes_context(data[:routes])
    end

    if data[:risks].any?
      sections << format_risks_context(data[:risks])
    end

    if data[:triage] && data[:triage][:features]&.any?
      sections << format_triage_context(data[:triage])
    end

    return "" if sections.empty?

    "# Wiki Enrichment Context\n\n" \
    "The following details come from the product wiki analysis. Use real names,\n" \
    "columns, routes, and risk levels from this context instead of inventing them.\n\n" +
    sections.join("\n\n")
  end

  # Returns risk-informed reordering suggestions for tasks.
  # Input: array of task hashes with "entities_touched" field.
  # Output: hash mapping entity names to risk severity.
  def risk_map
    extract_risks.each_with_object({}) do |risk, map|
      (risk[:entities] || []).each do |entity|
        existing = map[entity]
        map[entity] = risk[:severity] if !existing || severity_rank(risk[:severity]) > severity_rank(existing)
      end
    end
  end

  private

  def empty_enrichment
    { entities: {}, routes: [], risks: [], triage: nil }
  end

  def read_page(relative_path)
    path = File.join(wiki_dir, relative_path)
    return nil unless File.exist?(path)
    File.read(path, encoding: "UTF-8")
  end

  # Extract entity names and their fields from the data-and-entities page.
  # Returns: { "User" => { fields: ["email", "role", ...], relationships: [...] }, ... }
  def extract_entities
    content = read_page(ENTITY_PAGE)
    return {} unless content

    entities = {}
    current_entity = nil

    content.each_line do |line|
      # Match entity headings at any depth: ## User, ### CarePlan, #### Todo, etc.
      if line.match?(/^\#{2,5}\s+\w/)
        name = line.strip.sub(/^\#{2,5}\s+/, "").sub(/\s*\(.*\)/, "").strip
        # Skip generic section headings
        next if name.match?(/^(confirmed|inferred|gaps?|open questions|sources|purpose|relationships|overview|entity map)/i)
        current_entity = name
        entities[current_entity] = { fields: [], relationships: [] }
      elsif current_entity && entities[current_entity]
        # Match "Key attributes:" inline lists — common wiki format
        # e.g., "- **Key attributes:** email (unique), first name, mobile (optional, 10 digits)"
        if line.match?(/\*\*Key attributes?:?\*\*:?\s*(.+)/i)
          attrs_text = line[/\*\*Key attributes?:?\*\*:?\s*(.+)/i, 1]
          # Split carefully: commas inside parens are not separators
          extract_comma_list(attrs_text).each do |attr|
            field = attr.sub(/\s*\(.*\)/, "").strip
            # Convert multi-word to snake_case for field names
            field = field.gsub(/\s+/, "_").downcase unless field.empty?
            entities[current_entity][:fields] << field unless field.empty?
          end
        # Skip metadata lines (Purpose, Lifecycle, Business rules)
        elsif line.match?(/^\s*[-*]\s+\*\*(Purpose|Lifecycle|Business rules?|Context)\*\*:/i)
          # Skip — these are entity metadata, not field names
        # Match field listings: - `email` (string), | email | string |
        elsif line.match?(/^\s*[-*]\s+`(\w+)`/)
          field = line[/^\s*[-*]\s+`(\w+)`/, 1]
          entities[current_entity][:fields] << field if field
        elsif line.match?(/^\|\s*`?(\w+)`?\s*\|/)
          field = line[/^\|\s*`?(\w+)`?\s*\|/, 1]
          entities[current_entity][:fields] << field if field && !field.match?(/^(field|column|name|attribute|type)/i)
        end
        # Match relationships: belongs_to, has_many, has one, etc.
        if line.match?(/\b(belongs_to|has_many|has_one|has many|references|foreign_key|many_to_many)\b/i)
          entities[current_entity][:relationships] << line.strip.sub(/^\s*[-*]\s+/, "")
        end
        # Match "Relationship(s):" line
        if line.match?(/\*\*Relationships?\*\*:\s*(.+)/i)
          entities[current_entity][:relationships] << line[/:\s*(.+)/, 1].strip
        end
      end
    end

    entities.reject { |_, v| v[:fields].empty? && v[:relationships].empty? }
  end

  # Extract routes/endpoints from interfaces page.
  # Returns: [{ method: "GET", path: "/users", description: "..." }, ...]
  def extract_routes
    content = read_page(ROUTES_PAGE)
    return [] unless content

    routes = []

    content.each_line do |line|
      # Match route patterns: GET /users, POST /api/v1/sessions, etc.
      # Routes may be wrapped in backticks: `GET /users`
      if line.match?(/\b(GET|POST|PUT|PATCH|DELETE)\s+\//)
        match = line.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`|]+)/)
        if match
          desc = line.sub(match[0], "").strip.sub(/^\s*[-—|:`]+\s*/, "").sub(/`\s*$/, "").strip
          routes << { method: match[1], path: match[2], description: desc }
        end
      end
    end

    routes.uniq { |r| [r[:method], r[:path]] }
  end

  # Extract risks with severity from the risks page.
  # Returns: [{ title: "...", severity: "HIGH", entities: [...], description: "..." }, ...]
  def extract_risks
    content = read_page(RISKS_PAGE)
    return [] unless content

    risks = []
    current_risk = nil

    content.each_line do |line|
      # Match risk headings: ### RISK-001: Title — Severity: HIGH
      if line.match?(/^\#{2,5}\s+/)
        raw_title = line.strip.sub(/^\#{2,5}\s+/, "")
        next if raw_title.match?(/^(confirmed|inferred|gaps?|open questions|sources|purpose|overview|risk register)/i)

        # Extract severity from heading if present: "— Severity: HIGH"
        severity = "MEDIUM"
        if raw_title.match?(/Severity:\s*(CRITICAL|HIGH|MEDIUM|LOW)/i)
          severity = raw_title[/Severity:\s*(CRITICAL|HIGH|MEDIUM|LOW)/i, 1].upcase
        end
        title = raw_title.sub(/\s*—?\s*Severity:\s*(CRITICAL|HIGH|MEDIUM|LOW)/i, "").strip

        current_risk = { title: title, severity: severity, entities: [], description: "" }
        risks << current_risk
      elsif current_risk
        # Match entity references in backticks
        backtick_entities = line.scan(/`([A-Z]\w+)`/).flatten
        current_risk[:entities].concat(backtick_entities)
        current_risk[:description] += line unless line.strip.empty?
      end
    end

    risks
  end

  # Extract triage decisions from migration-triage.yml.
  # Returns: { features: [{ feature: "...", disposition: "keep|change|drop", ... }], ... }
  def extract_triage
    content = read_page(TRIAGE_FILE)
    return nil unless content

    begin
      YAML.safe_load(content, permitted_classes: [Symbol])
    rescue => e
      $stderr.puts "Warning: Could not parse #{TRIAGE_FILE}: #{e.message}"
      nil
    end
  end

  # Split a comma-separated list, respecting parenthesized groups.
  # "email (unique), first name, mobile (optional, 10 digits)" →
  #   ["email (unique)", "first name", "mobile (optional, 10 digits)"]
  def extract_comma_list(text)
    items = []
    current = +""
    depth = 0
    text.each_char do |ch|
      case ch
      when "(" then depth += 1; current << ch
      when ")" then depth -= 1; current << ch
      when ","
        if depth > 0
          current << ch
        else
          items << current.strip unless current.strip.empty?
          current = +""
        end
      else
        current << ch
      end
    end
    items << current.strip unless current.strip.empty?
    items
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

  def format_entities_context(entities)
    lines = ["## Entities and Fields (from wiki)\n"]
    entities.each do |name, data|
      lines << "### #{name}"
      if data[:fields].any?
        lines << "Fields: #{data[:fields].join(', ')}"
      end
      if data[:relationships].any?
        lines << "Relationships:"
        data[:relationships].each { |r| lines << "  - #{r}" }
      end
      lines << ""
    end
    lines.join("\n")
  end

  def format_routes_context(routes)
    lines = ["## Routes and Endpoints (from wiki)\n"]
    routes.each do |route|
      desc = route[:description].empty? ? "" : " — #{route[:description]}"
      lines << "- `#{route[:method]} #{route[:path]}`#{desc}"
    end
    lines.join("\n")
  end

  def format_risks_context(risks)
    lines = ["## Risks (from wiki)\n"]
    lines << "Use these risk levels to inform task ordering within dependency tiers.\n"
    risks.each do |risk|
      entities = risk[:entities].any? ? " (affects: #{risk[:entities].join(', ')})" : ""
      lines << "- **#{risk[:severity]}**: #{risk[:title]}#{entities}"
    end
    lines.join("\n")
  end

  def format_triage_context(triage)
    features = triage["features"] || triage[:features] || []
    keep = features.select { |f| f["disposition"] == "keep" || f[:disposition] == "keep" }
    change = features.select { |f| f["disposition"] == "change" || f[:disposition] == "change" }
    drop = features.select { |f| f["disposition"] == "drop" || f[:disposition] == "drop" }

    lines = ["## Migration Triage Decisions (from wiki)\n"]
    lines << "Keep: #{keep.size}, Change: #{change.size}, Drop: #{drop.size}\n"

    if change.any?
      lines << "### Changed features (generate modified requirements)"
      change.each do |f|
        name = f["feature"] || f[:feature]
        desired = f["desired_behavior"] || f[:desired_behavior] || "TBD"
        lines << "- **#{name}**: #{desired}"
      end
      lines << ""
    end

    if drop.any?
      lines << "### Dropped features (generate absence tests only)"
      drop.each do |f|
        name = f["feature"] || f[:feature]
        lines << "- ~~#{name}~~ — do NOT generate implementation tasks"
      end
      lines << ""
    end

    lines.join("\n")
  end
end
