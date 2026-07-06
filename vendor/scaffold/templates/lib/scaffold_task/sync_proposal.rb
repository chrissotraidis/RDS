# encoding: utf-8
# frozen_string_literal: true
#
# Sync proposal parser + writer for bin/task sync.
#
# A sync proposal is a Markdown file at .scaffold/sync-proposal.md with two
# structural parts:
#
#   1. A top-level YAML frontmatter block (between --- fences at the file
#      start) with sync-wide metadata: generated_against_sha,
#      last_synced_spec_sha, generated_at.
#
#   2. A sequence of per-change blocks. Each block is a YAML frontmatter
#      block followed by a Markdown body describing the proposed task.
#      The frontmatter fences delimit the blocks; the Markdown body runs
#      until the next YAML fence or end of file.
#
# Example structure:
#
#   ---
#   generated_against_sha: abc123
#   last_synced_spec_sha: def456
#   generated_at: 2026-04-18T...
#   ---
#
#   # Sync proposal: 3 changes
#
#   <summary table>
#
#   ---
#   change_id: C-001
#   status: accept
#   classification: new-task
#   confidence: high
#   provenance:
#     spec_diff_hunk: "@@ -142,3 +142,8 @@ ..."
#   target:
#     position: 42
#     depends_on: [8]
#   ---
#
#   ### Proposed task 42: Password reset flow
#
#   <proposed done_when, description>
#
#   ---
#   change_id: C-002
#   ...
#
# This module is the skeleton. Phase 2 (generation) and Phase 3 (apply)
# will fill in the methods.
#
# Depends on stdlib only (yaml, json, time). Keep that constraint — no gems.

require "yaml"
require "json"
require "fileutils"
# `date` is listed in YAML.safe_load's permitted_classes below. Ruby may
# or may not autoload Date depending on the stdlib entry point — require
# explicitly so `Date` is always defined when permitted_classes is
# evaluated.
require "date"

module ScaffoldTask
  module SyncProposal
    PROPOSAL_PATH = ".scaffold/sync-proposal.md"

    # Valid classifications returned by the sync classifier.
    CLASSIFICATIONS = %w[
      new-task
      modify-pending
      inject-against-completed
      deprecate
      refinement-noop
    ].freeze

    # Valid per-change statuses the operator can set in the proposal.
    STATUSES = %w[accept reject edit].freeze

    # Valid self-reported confidence levels from the classifier.
    CONFIDENCES = %w[high medium low].freeze

    # Required frontmatter keys per change block. Validation fails closed
    # if any are missing — the operator's fix is to either complete the
    # block or delete it.
    REQUIRED_CHANGE_KEYS = %w[
      change_id
      status
      classification
      confidence
      provenance
    ].freeze

    REQUIRED_PROVENANCE_KEYS = %w[spec_diff_hunk].freeze

    # Required top-level frontmatter keys.
    REQUIRED_TOP_KEYS = %w[
      generated_against_sha
      last_synced_spec_sha
      generated_at
    ].freeze

    class ParseError < StandardError; end
    class ValidationError < StandardError
      attr_reader :block_id
      def initialize(message, block_id: nil)
        super(message)
        @block_id = block_id
      end
    end

    # Parse a proposal file into a structured representation.
    #
    # Returns { top: Hash, changes: [Hash, ...] } where each change has
    # :frontmatter (Hash) and :body (String) keys.
    #
    # Phase 3 will implement this. Phase 0 stub returns an empty structure
    # so callers can be wired without the parser being done.
    def self.parse(path = PROPOSAL_PATH)
      return empty_structure unless File.exist?(path)

      raw = File.read(path, encoding: "utf-8")
      blocks = split_frontmatter_blocks(raw)

      if blocks.empty?
        raise ParseError, "Proposal file is empty or contains no YAML frontmatter"
      end

      top_frontmatter = parse_yaml_fence(blocks.shift[:fence], source: "top-level frontmatter")
      changes = blocks.map.with_index do |block, idx|
        frontmatter = parse_yaml_fence(block[:fence], source: "change block #{idx + 1}")
        { frontmatter: frontmatter, body: block[:body].to_s.strip }
      end

      { top: top_frontmatter, changes: changes }
    end

    # Validate the parsed structure. Raises ValidationError with block_id
    # set on failure so callers can surface precise "fix block C-003" errors.
    #
    # Phase 3 will implement this beyond the field-presence check below.
    def self.validate!(parsed)
      raise ValidationError, "Missing top-level frontmatter" unless parsed[:top].is_a?(Hash)

      REQUIRED_TOP_KEYS.each do |key|
        unless parsed[:top].key?(key)
          raise ValidationError, "Top-level frontmatter missing required key: #{key}"
        end
      end

      seen_ids = {}
      parsed[:changes].each_with_index do |change, idx|
        fm = change[:frontmatter]
        raise ValidationError.new("Change block #{idx + 1}: missing frontmatter") unless fm.is_a?(Hash)

        block_id = fm["change_id"]
        REQUIRED_CHANGE_KEYS.each do |key|
          unless fm.key?(key)
            raise ValidationError.new(
              "Change block #{block_id || idx + 1}: missing required key `#{key}`",
              block_id: block_id
            )
          end
        end

        unless CLASSIFICATIONS.include?(fm["classification"])
          raise ValidationError.new(
            "Change block #{block_id}: invalid classification `#{fm["classification"]}`. " \
            "Must be one of: #{CLASSIFICATIONS.join(", ")}",
            block_id: block_id
          )
        end

        unless STATUSES.include?(fm["status"])
          raise ValidationError.new(
            "Change block #{block_id}: invalid status `#{fm["status"]}`. " \
            "Must be one of: #{STATUSES.join(", ")}",
            block_id: block_id
          )
        end

        unless CONFIDENCES.include?(fm["confidence"])
          raise ValidationError.new(
            "Change block #{block_id}: invalid confidence `#{fm["confidence"]}`. " \
            "Must be one of: #{CONFIDENCES.join(", ")}",
            block_id: block_id
          )
        end

        provenance = fm["provenance"]
        unless provenance.is_a?(Hash)
          raise ValidationError.new(
            "Change block #{block_id}: `provenance` must be a mapping",
            block_id: block_id
          )
        end

        REQUIRED_PROVENANCE_KEYS.each do |key|
          unless provenance.key?(key)
            raise ValidationError.new(
              "Change block #{block_id}: provenance missing required key `#{key}`",
              block_id: block_id
            )
          end
        end

        if seen_ids.key?(block_id)
          raise ValidationError.new(
            "Duplicate change_id `#{block_id}` in proposal",
            block_id: block_id
          )
        end
        seen_ids[block_id] = true
      end

      true
    end

    # Extract the raw task_payload JSON from a change block's body.
    # Looks for the canonical `<details><summary>Raw task payload</summary>`
    # fenced json block. Returns nil when not present (for noop blocks).
    #
    # If the operator edited the JSON block, we take their edits — that's
    # the canonical source. The surrounding prose is informational.
    def self.extract_task_payload(body)
      return nil unless body.is_a?(String)
      if (m = body.match(/<details>[^<]*<summary>\s*Raw task payload\s*<\/summary>\s*\n?\s*```json\s*\n(.*?)\n\s*```/m))
        JSON.parse(m[1])
      end
    rescue JSON::ParserError
      nil
    end

    # Write a proposal to disk. Phase 2 will use this after generation.
    def self.write(top:, changes:, path: PROPOSAL_PATH)
      FileUtils.mkdir_p(File.dirname(path))
      lines = []
      lines << "---"
      lines << top.to_yaml.sub(/\A---\n/, "").rstrip
      lines << "---"
      lines << ""

      changes.each do |change|
        lines << "---"
        lines << change[:frontmatter].to_yaml.sub(/\A---\n/, "").rstrip
        lines << "---"
        lines << ""
        lines << change[:body].to_s.rstrip
        lines << ""
      end

      File.write(path, lines.join("\n") + "\n")
    end

    # Internal: split file into alternating fence/body regions.
    # Each returned block has :fence (raw YAML text between --- lines) and
    # :body (Markdown content until the next fence or EOF).
    #
    # A standalone `---` line is ambiguous in Markdown — it can be a YAML
    # frontmatter fence OR a Markdown horizontal rule. We disambiguate by
    # looking at what follows: a fence is always immediately followed by
    # a YAML key line (`key:` or `key: value`). Anything else is treated
    # as a horizontal rule and left in the body text.
    #
    # This lets change-block bodies contain Markdown `---` separators
    # (common in task descriptions) without breaking proposal parsing.
    def self.split_frontmatter_blocks(raw)
      lines = raw.split("\n", -1)
      blocks = []
      i = 0
      pending_body = []

      while i < lines.length
        if lines[i].strip == "---" && yaml_fence_opens_at?(lines, i)
          # Attach any pending body to the previous block
          if !blocks.empty? && !pending_body.empty?
            blocks.last[:body] = pending_body.join("\n")
            pending_body = []
          end

          fence_lines = []
          i += 1
          while i < lines.length && lines[i].strip != "---"
            fence_lines << lines[i]
            i += 1
          end
          # i now points to the closing --- or past the end
          blocks << { fence: fence_lines.join("\n"), body: "" }
          i += 1 if i < lines.length  # skip the closing ---
        else
          pending_body << lines[i] if !blocks.empty?
          i += 1
        end
      end

      # Attach any trailing body to the last block
      if !blocks.empty? && !pending_body.empty?
        blocks.last[:body] = pending_body.join("\n")
      end

      blocks
    end

    # Internal: decide whether a `---` at line `idx` opens a YAML fence
    # (as opposed to being a Markdown horizontal rule in body text).
    #
    # A fence's next non-blank line must look like a YAML key: either an
    # identifier followed by `:` (with optional value), or the closing
    # `---` (empty frontmatter, unusual but valid). Anything else is body.
    YAML_KEY_LINE = /\A\s*[A-Za-z_][A-Za-z0-9_\-]*\s*:/.freeze

    def self.yaml_fence_opens_at?(lines, idx)
      j = idx + 1
      while j < lines.length && lines[j].strip.empty?
        j += 1
      end
      return false if j >= lines.length
      return true if lines[j].strip == "---"
      !!(lines[j] =~ YAML_KEY_LINE)
    end

    def self.parse_yaml_fence(text, source:)
      YAML.safe_load(text, permitted_classes: [Symbol, Date, Time]) || {}
    rescue Psych::SyntaxError => e
      raise ParseError, "Invalid YAML in #{source}: #{e.message}"
    end

    def self.empty_structure
      { top: {}, changes: [] }
    end
  end
end
