#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# apply_feedback.rb — Apply mockup feedback to the specification
#
# Reads feedback markdown + current spec, calls Claude to produce an updated spec,
# shows a diff for user confirmation, then writes the updated spec.
#
# Usage:
#   ruby lib/apply_feedback.rb --feedback mockup-feedback.md --spec spec.md
#   ruby lib/apply_feedback.rb --feedback mockup-feedback.md --spec spec.md --yes
#
# The --yes flag skips confirmation (for automation).

require "optparse"
require "open3"
require "tempfile"
require "fileutils"

options = { yes: false }
OptionParser.new do |opts|
  opts.banner = "Usage: apply_feedback.rb --feedback FILE --spec FILE [--yes]"
  opts.on("--feedback FILE", "Feedback markdown file") { |v| options[:feedback] = v }
  opts.on("--spec FILE", "Specification file to update") { |v| options[:spec] = v }
  opts.on("--yes", "Skip confirmation prompt") { options[:yes] = true }
end.parse!

%i[feedback spec].each do |key|
  abort "Missing --#{key}" unless options[key]
  abort "File not found: #{options[key]}" unless File.exist?(options[key])
end

# ─── Load inputs ───

feedback_text = File.read(options[:feedback], encoding: "UTF-8")
spec_text = File.read(options[:spec], encoding: "UTF-8")

# Validate feedback has actual entries (not just the template)
feedback_entries = feedback_text.scan(/^###\s+.+/).size
if feedback_entries == 0
  $stderr.puts "No feedback entries found in #{options[:feedback]}"
  $stderr.puts "Add entries using the format:"
  $stderr.puts "  ### Screen Name"
  $stderr.puts "  **What to change:** ..."
  $stderr.puts "  **Why:** ..."
  $stderr.puts "  **Priority:** high/medium/low"
  exit 1
end

$stderr.puts "Found #{feedback_entries} feedback entries"

# ─── Check for Claude CLI ───

claude_path = `which claude 2>/dev/null`.strip
abort "claude CLI not found" if claude_path.empty?

# ─── Load feedback prompt template ───

scaffold_dir = File.expand_path("..", __dir__)
prompt_path = File.join(scaffold_dir, "prompts", "feedback_to_spec_system.md.erb")

if File.exist?(prompt_path)
  require "erb"
  system_prompt = ERB.new(File.read(prompt_path, encoding: "UTF-8"), trim_mode: "-").result(binding)
else
  # Fallback inline prompt
  system_prompt = <<~PROMPT
    You are a technical specification editor. Read the feedback from a mockup review
    and produce an updated version of the specification that incorporates the feedback.
    Preserve the spec's existing structure and only modify sections affected by feedback.
    Output ONLY the complete updated specification text.
  PROMPT
end

# ─── Build combined prompt ───

combined_prompt = <<~PROMPT
  #{system_prompt}

  ---

  # CURRENT SPECIFICATION

  #{spec_text}

  ---

  # FEEDBACK FROM MOCKUP REVIEW

  #{feedback_text}

  ---

  Produce the complete updated specification incorporating the feedback above.
PROMPT

# ─── Call Claude ───

$stderr.puts "Generating spec updates from feedback (calling Claude)..."

prompt_data = combined_prompt.encode("UTF-8", invalid: :replace, undef: :replace)

stdout, _stderr, status = Open3.capture3(
  claude_path, "-p",
  "--max-turns", "3",
  "--model", "sonnet",
  "--dangerously-skip-permissions",
  stdin_data: prompt_data
)

unless status.success?
  $stderr.puts "Warning: Claude CLI returned non-zero exit code"
end

updated_spec = stdout.strip

# Handle CLI envelope
begin
  envelope = JSON.parse(updated_spec)
  if envelope.is_a?(Hash) && envelope["type"] == "result" && envelope["result"]
    updated_spec = envelope["result"].strip
  end
rescue
  # Not JSON envelope, which is expected (we want markdown text)
end

# Strip markdown fences if Claude wrapped the output
updated_spec = updated_spec.sub(/\A```(?:markdown|md)?\s*\n/, "").sub(/\n```\s*\z/, "")

# ─── Validate the updated spec ───

if updated_spec.size < spec_text.size * 0.5
  $stderr.puts "Error: Updated spec is less than half the original size. Something went wrong."
  $stderr.puts "Original: #{spec_text.size} chars, Updated: #{updated_spec.size} chars"
  exit 1
end

if updated_spec.strip == spec_text.strip
  $stderr.puts "No changes detected — the spec appears unchanged after applying feedback."
  exit 0
end

# ─── Show diff ───

original_tmp = Tempfile.new(["spec-original", ".md"])
updated_tmp = Tempfile.new(["spec-updated", ".md"])

begin
  original_tmp.write(spec_text)
  original_tmp.flush
  updated_tmp.write(updated_spec)
  updated_tmp.flush

  # Generate unified diff
  diff_output, = Open3.capture2(
    "diff", "-u",
    "--label", "spec.md (original)",
    "--label", "spec.md (with feedback)",
    original_tmp.path,
    updated_tmp.path
  )

  if diff_output.strip.empty?
    $stderr.puts "No differences detected."
    exit 0
  end

  # Count changes
  additions = diff_output.lines.count { |l| l.start_with?("+") && !l.start_with?("+++") }
  deletions = diff_output.lines.count { |l| l.start_with?("-") && !l.start_with?("---") }

  puts ""
  puts "Proposed spec changes: +#{additions} lines, -#{deletions} lines"
  puts "=" * 60

  # Colorize diff output
  diff_output.each_line do |line|
    case line
    when /^\+{3}/  then print "\e[1m#{line}\e[0m"      # bold for file headers
    when /^-{3}/   then print "\e[1m#{line}\e[0m"
    when /^@@/     then print "\e[36m#{line}\e[0m"      # cyan for hunks
    when /^\+/     then print "\e[32m#{line}\e[0m"      # green for additions
    when /^-/      then print "\e[31m#{line}\e[0m"      # red for deletions
    else                print line
    end
  end

  puts "=" * 60
  puts ""

  # ─── Confirm and apply ───

  if options[:yes]
    $stderr.puts "Auto-applying (--yes flag)"
  else
    print "Apply these changes to #{options[:spec]}? [y/N] "
    answer = $stdin.gets&.strip&.downcase
    unless answer == "y" || answer == "yes"
      $stderr.puts "Aborted. No changes made."
      exit 0
    end
  end

  # Backup original
  backup_path = "#{options[:spec]}.backup"
  FileUtils.cp(options[:spec], backup_path)
  $stderr.puts "Backup saved to #{backup_path}"

  # Write updated spec
  File.write(options[:spec], updated_spec)
  $stderr.puts "Spec updated: #{options[:spec]}"
  $stderr.puts "  +#{additions} lines, -#{deletions} lines applied"

ensure
  original_tmp.close
  original_tmp.unlink
  updated_tmp.close
  updated_tmp.unlink
end
