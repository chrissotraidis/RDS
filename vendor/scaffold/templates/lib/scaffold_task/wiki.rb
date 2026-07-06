# encoding: utf-8
# frozen_string_literal: true
#
# Wiki context pre-resolution for bin/task dossier.
#
# Looks up a task's entities_touched against the product wiki's entities page
# and inlines real field names + risk flags into the dossier. This turns
# wiki consumption from "agent pulls if it remembers" into "guaranteed
# in-context."
#
# Depends on templates/lib/wiki_enricher.rb (copied alongside bin/task by
# scaffold.sh when --wiki is provided). If the wiki directory is absent or
# wiki_enricher.rb isn't loadable, every helper returns "" — safe to call
# unconditionally from the dossier.

WIKI_DIR_DEFAULT = "wiki"
WIKI_EXCERPT_BUDGET = 1200  # bytes across entities + risks combined

# Resolve the wiki dir in priority order: explicit arg > config.yml's
# wiki_bridge.wiki_dir > ./wiki. The config.yml path matches what scaffold.sh
# wrote at scaffold time, so relative paths (e.g. "../coaching9-wiki") and
# absolute paths both resolve correctly without needing to live under the
# project root.
def resolve_wiki_dir(explicit = nil)
  return explicit if explicit && File.directory?(explicit)
  if defined?(CONFIG_FILE) && File.exist?(CONFIG_FILE)
    begin
      data = YAML.safe_load_file(CONFIG_FILE, permitted_classes: [Symbol])
      configured = data.is_a?(Hash) ? data.dig("wiki_bridge", "wiki_dir").to_s : ""
      return configured if !configured.empty? && File.directory?(configured)
    rescue Psych::SyntaxError, StandardError
      # fall through to default
    end
  end
  File.directory?(WIKI_DIR_DEFAULT) ? WIKI_DIR_DEFAULT : nil
end

def wiki_enricher_available?(dir)
  return false unless dir && File.directory?(dir)
  enricher_path = File.expand_path("../../lib/wiki_enricher.rb", __dir__)
  return false unless File.exist?(enricher_path)
  require_relative File.join(File.dirname(enricher_path), "wiki_enricher")
  true
rescue LoadError, StandardError
  false
end

# Returns a Markdown block resolving the task's entities_touched against the
# wiki, plus any high-severity risk flags. Returns "" when nothing in-scope
# resolves (no wiki, no entities_touched, or no overlap).
def wiki_context_for_task(task, dir: nil, budget: WIKI_EXCERPT_BUDGET)
  dir = resolve_wiki_dir(dir)
  return "" unless wiki_enricher_available?(dir)

  entities_touched = Array(task["entities_touched"]).map(&:to_s).reject(&:empty?)
  return "" if entities_touched.empty?

  enricher = WikiEnricher.new(dir)
  all_entities = enricher.enrich[:entities] || {}
  risk_map = enricher.risk_map

  # Case-insensitive match — wiki headings and task fields don't always agree on case.
  wiki_keys_by_lower = all_entities.keys.each_with_object({}) { |k, h| h[k.downcase] = k }
  matched = entities_touched.map { |e| wiki_keys_by_lower[e.downcase] }.compact.uniq

  risk_flags = entities_touched.each_with_object({}) do |entity, acc|
    sev = risk_map[entity] || risk_map[wiki_keys_by_lower[entity.downcase]]
    acc[entity] = sev if sev
  end

  return "" if matched.empty? && risk_flags.empty?

  out = []
  out << "## Wiki Context"
  out << ""

  unless risk_flags.empty?
    out << "### ⚠️ Risk Flags"
    out << ""
    risk_flags.sort_by { |_, sev| -severity_rank(sev) }.each do |entity, sev|
      out << "- **#{entity}** (#{sev.to_s.upcase} severity) — tightened tests, migration guards, or input validation likely warranted."
    end
    out << ""
  end

  unless matched.empty?
    out << "### Entities (from wiki/engineering/data-and-entities.md)"
    out << ""
    total = out.join("\n").bytesize
    matched.each do |name|
      info = all_entities[name] || {}
      fields = Array(info[:fields]).uniq.first(12)
      rels = Array(info[:relationships]).uniq.first(3)
      block = []
      block << "**#{name}**"
      block << "- Fields: #{fields.join(", ")}" unless fields.empty?
      rels.each { |r| block << "- #{r}" } unless rels.empty?
      block << ""
      chunk = block.join("\n") + "\n"
      if total + chunk.bytesize > budget
        out << "_(#{matched.length - matched.index(name)} more entities omitted to fit #{budget}-byte budget)_"
        break
      end
      out << chunk
      total += chunk.bytesize
    end
  end

  out << "Use these real names; do not invent alternatives. If a field you need isn't listed, note it in your execution plan rather than silently adding one."
  out.join("\n")
end

# Lower = less severe. Matches wiki_enricher's internal ordering.
def severity_rank(sev)
  case sev.to_s.downcase
  when "critical" then 4
  when "high" then 3
  when "medium" then 2
  when "low" then 1
  else 0
  end
end
