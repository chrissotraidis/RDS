#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# render_mockup.rb — Deterministic mockup renderer
#
# Walks a mockup-manifest.json (from extract_screens.rb) and emits a single
# self-contained mockup/index.html with Tailwind CDN + Alpine.js CDN. No LLM
# calls — renders screens from their declared components, interactive
# elements, and seed data.
#
# This is a lo-fi structural preview. High-fidelity mocks are produced by the
# coding agent at build time from the same manifest.
#
# Usage:
#   ruby lib/render_mockup.rb \
#     --manifest mockup-manifest.json \
#     --output mockup/

require "json"
require "erb"
require "optparse"
require "fileutils"
require "cgi"

class MockupRenderer
  def initialize(manifest)
    @manifest = manifest
    @screens = Array(manifest["screens"])
    @roles = Array(manifest["roles"]).reject { |r| r.nil? || r.empty? }
    @roles = ["user"] if @roles.empty?
    @navigation = manifest["navigation"] || {}
    @seed_data = manifest["seed_data"] || {}
    @layout = manifest["layout"] || { "type" => "sidebar" }
    @project_name = manifest["project_name"] || "Application"
  end

  attr_reader :project_name, :roles, :screens, :layout

  def render(template_path)
    ERB.new(File.read(template_path, encoding: "UTF-8"), trim_mode: "-").result(binding)
  end

  def screens_for_js
    @screens.map do |s|
      { id: s["id"], name: s["name"], role: s["role"] || "shared" }
    end
  end

  def nav_for_js
    out = {}
    @roles.each do |role|
      items = @navigation[role]
      items = nil if items.is_a?(Array) && items.empty?
      if items.nil?
        # Synthesize nav from screens assigned to this role (plus shared).
        candidates = @screens.select { |s| s["role"] == role || s["role"] == "shared" || s["role"].nil? }
        items = candidates.map { |s| { "label" => s["name"], "screen_id" => s["id"] } }
      end
      out[role] = items.map { |i| { label: i["label"] || i["name"], screen_id: i["screen_id"] || i["id"] } }
    end
    out
  end

  def initial_screen
    # Prefer a "shared" login/landing screen if present; otherwise first screen for the first role.
    login = @screens.find { |s| %w[login landing splash welcome].include?(s["id"]) }
    return login["id"] if login
    first_role = @roles.first
    first = @screens.find { |s| s["role"] == first_role || s["role"] == "shared" || s["role"].nil? }
    first&.dig("id") || @screens.first&.dig("id") || "home"
  end

  # ─── Per-screen rendering ──────────────────────────────────────────────

  def render_screen(screen)
    parts = []
    parts << render_header(screen)

    interactive = Array(screen["interactive_elements"])
    parts << render_interactive_bar(interactive) if interactive.any?

    components = Array(screen["components"])
    if components.empty?
      parts << render_default_body(screen)
    else
      components.each { |c| parts << render_component(c, screen) }
    end

    parts.compact.join("\n")
  end

  private

  def h(text)
    CGI.escapeHTML(text.to_s)
  end

  def primary_entity(screen)
    Array(screen["data_entities"]).first
  end

  def entity_name(entity)
    return nil unless entity
    entity.is_a?(Hash) ? entity["entity"] : entity.to_s
  end

  def entity_fields(entity)
    return [] unless entity.is_a?(Hash)
    Array(entity["displayed_fields"])
  end

  def seed_rows(entity_name, limit: nil)
    rows = Array(@seed_data[entity_name])
    limit ? rows.first(limit) : rows
  end

  # Pick a navigable detail target from a screen's related_screens. Prefers
  # IDs that look detail-shaped (detail/show/view/edit), then falls back to
  # the first related_screen that actually exists in the manifest. Returns
  # nil if no usable target exists — callers render a muted placeholder.
  def detail_target_for(screen)
    candidates = Array(screen["related_screens"]).map(&:to_s).reject(&:empty?)
    return nil if candidates.empty?
    known_ids = @screens.map { |s| s["id"] }
    detail_like = candidates.find do |id|
      known_ids.include?(id) && id.match?(/detail|show|view|edit|profile/i)
    end
    detail_like || candidates.find { |id| known_ids.include?(id) }
  end

  # ─── Components ───────────────────────────────────────────────────────

  def render_header(screen)
    name = h(screen["name"] || screen["id"])
    desc = screen["description"]
    <<~HTML
      <div class="mb-6">
        <h2 class="text-2xl font-bold text-gray-900">#{name}</h2>
        #{desc ? %(<p class="text-gray-500 mt-1">#{h(desc)}</p>) : ""}
      </div>
    HTML
  end

  def render_interactive_bar(elements)
    controls = elements.map { |el| render_interactive(el) }.compact
    return nil if controls.empty?
    <<~HTML
      <div class="flex flex-wrap items-center gap-3 mb-6 p-3 bg-white rounded-lg border border-gray-200">
        #{controls.join("\n        ")}
      </div>
    HTML
  end

  def render_interactive(kind)
    case kind.to_s.downcase
    when "search_filter", "search", "search_bar"
      %(<input type="search" placeholder="Search…" class="flex-1 min-w-[180px] px-3 py-2 border border-gray-300 rounded-md text-sm">)
    when "date_picker", "date", "datepicker"
      %(<input type="date" class="px-3 py-2 border border-gray-300 rounded-md text-sm">)
    when "toggle", "switch"
      %(<label class="inline-flex items-center cursor-pointer gap-2 text-sm"><input type="checkbox" class="sr-only peer"><div class="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:bg-indigo-600 relative after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div><span class="text-gray-700">Toggle</span></label>)
    when "slider", "range"
      %(<input type="range" class="w-32 accent-indigo-600">)
    when "dropdown", "select"
      %(<select class="px-3 py-2 border border-gray-300 rounded-md text-sm"><option>Option 1</option><option>Option 2</option></select>)
    when "file_upload", "upload"
      %(<button class="px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-sm hover:bg-gray-200">Upload file</button>)
    when "drag_and_drop", "drag_drop", "dnd"
      %(<div class="px-4 py-3 border-2 border-dashed border-gray-300 rounded-md text-sm text-gray-500">Drop files here</div>)
    when "button", "action_button", "primary_action"
      %(<button class="px-4 py-2 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700">Action</button>)
    else
      %(<span class="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded-md">#{h(kind)}</span>)
    end
  end

  def render_component(type, screen)
    case type.to_s.downcase
    when "data_table", "table"         then render_table(screen)
    when "card_grid", "cards", "grid"  then render_cards(screen)
    when "list"                        then render_list(screen)
    when "form"                        then render_form(screen)
    when "chart", "graph", "sparkline" then render_chart(screen, type)
    when "tabs"                        then render_tabs(screen)
    when "modal"                       then render_modal(screen)
    when "detail_view", "detail"       then render_detail(screen)
    when "kpi", "stat", "stats", "metrics"
                                       then render_kpis(screen)
    else render_placeholder(type, screen)
    end
  end

  def render_table(screen)
    entity = primary_entity(screen)
    name = entity_name(entity)
    fields = entity_fields(entity)
    rows = seed_rows(name, limit: 8)

    if rows.empty? || fields.empty?
      return render_placeholder("data_table", screen, hint: "No seed data for this entity")
    end

    header_cells = fields.map { |f| %(<th class="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide">#{h(f)}</th>) }.join
    body_rows = rows.map do |row|
      cells = fields.map { |f| %(<td class="px-4 py-2 text-sm text-gray-700">#{h(row[f])}</td>) }.join
      %(<tr class="border-t border-gray-100">#{cells}</tr>)
    end.join("\n")

    <<~HTML
      <div class="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
        <div class="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 class="text-sm font-semibold text-gray-800">#{h(name || "Records")}</h3>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full">
            <thead class="bg-white"><tr>#{header_cells}</tr></thead>
            <tbody>#{body_rows}</tbody>
          </table>
        </div>
      </div>
    HTML
  end

  def render_cards(screen)
    entity = primary_entity(screen)
    name = entity_name(entity)
    fields = entity_fields(entity)
    rows = seed_rows(name, limit: 6)

    return render_placeholder("card_grid", screen, hint: "No seed data") if rows.empty?

    cards = rows.map do |row|
      title = row[fields.first] || row.values.first
      detail_lines = fields.drop(1).first(3).map do |f|
        %(<div class="text-sm text-gray-600"><span class="text-gray-400">#{h(f)}:</span> #{h(row[f])}</div>)
      end.join("\n")
      <<~CARD
        <div class="bg-white rounded-lg border border-gray-200 p-4">
          <h4 class="font-semibold text-gray-900 mb-2">#{h(title)}</h4>
          #{detail_lines}
        </div>
      CARD
    end.join("\n")

    <<~HTML
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        #{cards}
      </div>
    HTML
  end

  def render_list(screen)
    entity = primary_entity(screen)
    name = entity_name(entity)
    fields = entity_fields(entity)
    rows = seed_rows(name, limit: 8)

    return render_placeholder("list", screen, hint: "No seed data") if rows.empty?

    # Wire "View" to the first related screen so list→detail flows work even
    # when the detail screen isn't in role navigation. Falls back to a muted
    # label when no related_screens are declared.
    detail_target = detail_target_for(screen)
    action_html = if detail_target
      %(<button @click="navigate('#{h(detail_target)}')" class="text-xs text-indigo-600 hover:text-indigo-700 shrink-0">View →</button>)
    else
      %(<span class="text-xs text-gray-400 shrink-0">—</span>)
    end

    items = rows.map do |row|
      primary = row[fields.first] || row.values.first
      secondary = fields[1] ? row[fields[1]] : nil
      secondary_html = secondary ? %(<div class="text-sm text-gray-500">#{h(secondary)}</div>) : ""
      <<~ITEM
        <li class="flex items-start justify-between px-4 py-3">
          <div>
            <div class="text-sm font-medium text-gray-900">#{h(primary)}</div>
            #{secondary_html}
          </div>
          #{action_html}
        </li>
      ITEM
    end.join("\n")

    <<~HTML
      <div class="bg-white rounded-lg border border-gray-200 mb-6">
        <div class="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 class="text-sm font-semibold text-gray-800">#{h(name || "Items")}</h3>
        </div>
        <ul class="divide-y divide-gray-100">#{items}</ul>
      </div>
    HTML
  end

  def render_form(screen)
    entity = primary_entity(screen)
    fields = entity_fields(entity)
    fields = %w[name email message] if fields.empty?

    inputs = fields.first(8).map do |field|
      kind = guess_input_type(field)
      input_html =
        case kind
        when :textarea
          %(<textarea rows="4" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" placeholder="Enter #{h(field)}…"></textarea>)
        when :select
          %(<select class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"><option>Option A</option><option>Option B</option></select>)
        when :date
          %(<input type="date" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm">)
        when :email
          %(<input type="email" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" placeholder="you@example.com">)
        when :password
          %(<input type="password" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm">)
        else
          %(<input type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" placeholder="Enter #{h(field)}…">)
        end
      <<~FIELD
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">#{h(field.to_s.tr('_', ' ').capitalize)}</label>
          #{input_html}
        </div>
      FIELD
    end.join("\n")

    <<~HTML
      <form class="bg-white rounded-lg border border-gray-200 p-6 mb-6 space-y-4 max-w-2xl">
        #{inputs}
        <div class="pt-2 flex gap-2">
          <button type="button" class="px-4 py-2 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700">Submit</button>
          <button type="button" class="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm hover:bg-gray-50">Cancel</button>
        </div>
      </form>
    HTML
  end

  def guess_input_type(field)
    f = field.to_s.downcase
    return :email    if f.include?("email")
    return :password if f.include?("password") || f.include?("secret")
    return :date     if f.match?(/\b(date|start|end|deadline|at|on)\b/)
    return :textarea if f.match?(/\b(description|notes?|body|message|content|comment)\b/)
    return :select   if f.match?(/\b(status|role|type|category|priority)\b/)
    :text
  end

  def render_chart(screen, type)
    # Generate a deterministic polyline from seed data or the screen id hash.
    entity = primary_entity(screen)
    rows = seed_rows(entity_name(entity), limit: 10)
    seed = screen["id"].to_s
    points = (0...10).map do |i|
      base = rows[i] ? (rows[i].values.find { |v| v.is_a?(Numeric) } || seed.bytes.sum) : seed.bytes.sum
      x = 20 + (i * 40)
      y = 120 - (((base.to_i + i * 7) % 90) + 5)
      "#{x},#{y}"
    end.join(" ")

    <<~HTML
      <div class="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <h3 class="text-sm font-semibold text-gray-800 mb-4">#{h((type || "Chart").to_s.capitalize)}</h3>
        <svg viewBox="0 0 400 140" class="w-full h-40">
          <polyline fill="none" stroke="#6366F1" stroke-width="2" points="#{points}" />
          <line x1="0" y1="130" x2="400" y2="130" stroke="#E5E7EB" />
        </svg>
      </div>
    HTML
  end

  def render_tabs(screen)
    labels = Array(screen["components"]).size > 1 ? %w[Overview Activity Settings] : %w[Overview Details]
    tabs_html = labels.each_with_index.map do |label, i|
      cls = i.zero? ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-500 hover:text-gray-700"
      %(<button class="px-4 py-2 text-sm font-medium border-b-2 #{cls}">#{h(label)}</button>)
    end.join("\n")
    <<~HTML
      <div class="mb-6">
        <div class="flex gap-2 border-b border-gray-200">#{tabs_html}</div>
        <div class="py-6 text-sm text-gray-500">#{h(labels.first)} tab content</div>
      </div>
    HTML
  end

  def render_modal(screen)
    <<~HTML
      <div class="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <p class="text-sm text-gray-600 mb-3">Modal trigger</p>
        <button class="px-4 py-2 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700">Open dialog</button>
      </div>
    HTML
  end

  def render_detail(screen)
    entity = primary_entity(screen)
    fields = entity_fields(entity)
    row = seed_rows(entity_name(entity), limit: 1).first

    return render_placeholder("detail_view", screen, hint: "No seed record") unless row

    rows = fields.map do |f|
      <<~ROW
        <div class="flex justify-between py-3 border-t border-gray-100">
          <div class="text-sm text-gray-500">#{h(f.to_s.tr('_', ' ').capitalize)}</div>
          <div class="text-sm text-gray-900 text-right">#{h(row[f])}</div>
        </div>
      ROW
    end.join("\n")

    <<~HTML
      <div class="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        #{rows}
      </div>
    HTML
  end

  def render_kpis(screen)
    # Four deterministic stat cards based on the first few numeric seed values.
    entity = primary_entity(screen)
    rows = seed_rows(entity_name(entity))
    stats = [
      { label: "Total",    value: rows.size },
      { label: "Active",   value: (rows.size * 0.75).round },
      { label: "This week", value: (rows.size * 0.4).round },
      { label: "Growth",   value: "+12%" }
    ]
    cards = stats.map do |s|
      <<~CARD
        <div class="bg-white rounded-lg border border-gray-200 p-4">
          <div class="text-xs text-gray-500 uppercase tracking-wide">#{h(s[:label])}</div>
          <div class="text-2xl font-bold text-gray-900 mt-1">#{h(s[:value])}</div>
        </div>
      CARD
    end.join("\n")
    %(<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">\n#{cards}\n</div>)
  end

  def render_placeholder(type, screen, hint: nil)
    label = h(type.to_s.tr("_", " ").capitalize)
    hint_html = hint ? %(<p class="text-xs text-gray-400 mt-1">#{h(hint)}</p>) : ""
    <<~HTML
      <div class="bg-white rounded-lg border border-dashed border-gray-300 p-6 mb-6 text-center">
        <p class="text-sm text-gray-600 font-medium">#{label}</p>
        #{hint_html}
      </div>
    HTML
  end

  def render_default_body(screen)
    # No declared components — render whichever data we have.
    entity = primary_entity(screen)
    if entity
      render_cards(screen)
    else
      <<~HTML
        <div class="bg-white rounded-lg border border-gray-200 p-8 text-center mb-6">
          <p class="text-gray-500">#{h(screen["description"] || "Screen content")}</p>
        </div>
      HTML
    end
  end
end

# ─── CLI ──────────────────────────────────────────────────────────────

if $PROGRAM_NAME == __FILE__
  options = {}
  OptionParser.new do |opts|
    opts.banner = "Usage: render_mockup.rb --manifest FILE --output DIR"
    opts.on("--manifest FILE") { |v| options[:manifest] = v }
    opts.on("--output DIR")    { |v| options[:output] = v }
  end.parse!

  %i[manifest output].each do |key|
    abort "Missing --#{key}" unless options[key]
  end

  manifest = JSON.parse(File.read(options[:manifest], encoding: "UTF-8"))
  renderer = MockupRenderer.new(manifest)

  template_path = File.join(__dir__, "..", "templates", "mockup_preview.html.erb")
  abort "Template not found: #{template_path}" unless File.exist?(template_path)

  html = renderer.render(template_path)

  FileUtils.mkdir_p(options[:output])
  output_path = File.join(options[:output], "index.html")
  File.write(output_path, html)

  $stderr.puts "  Rendered #{renderer.screens.size} screens → #{output_path}"
end
