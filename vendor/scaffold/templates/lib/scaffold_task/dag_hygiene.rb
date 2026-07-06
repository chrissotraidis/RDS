# encoding: utf-8
# frozen_string_literal: true
#
# DAG hygiene helpers: cycle detection + transitive reduction.
#
# Called by `bin/task sync --apply` before writing tasks.json. Cycle
# detection is a safety gate (classifier should never produce cycles,
# but catching them here is cheap insurance). Transitive reduction
# keeps the depends_on graph minimal after repeated syncs — the debate
# synthesis called this "dependency bloat" and flagged it as the
# iteration-10 problem.
#
# Depends on stdlib only (set).

require "set"

module ScaffoldTask
  module DagHygiene
    class CycleError < StandardError
      attr_reader :cycle
      def initialize(cycle)
        @cycle = cycle
        super("Cycle detected in depends_on graph: #{cycle.join(" -> ")}")
      end
    end

    # Walks the tasks' depends_on graph, returns the first cycle found
    # as an ordered list of positions (the cycle repeats the first node
    # at the end so the full loop is visible). Returns nil when no cycle.
    def self.find_cycle(tasks)
      edges = build_edges(tasks)
      colors = {} # :gray, :black; absent = white
      cycle = nil

      edges.keys.each do |start|
        next if colors.key?(start)
        path = []
        cycle = dfs_cycle(start, edges, colors, path)
        break if cycle
      end

      cycle
    end

    # Raises CycleError if there's a cycle. Use in apply flows where
    # any cycle is a hard stop.
    def self.assert_acyclic!(tasks)
      cycle = find_cycle(tasks)
      raise CycleError.new(cycle) if cycle
      true
    end

    # Remove edges that are implied by longer paths. For each task X
    # with depends_on [A, B], if B can transitively reach A via its own
    # depends_on, then X's direct edge to A is redundant — B will have
    # to clear A before it can run.
    #
    # Mutates tasks in place. Returns an array of pruned-edge records:
    #   [ { position: X, pruned: [A, ...] }, ... ]
    # so the caller can log which edges were dropped.
    def self.transitive_reduce!(tasks)
      edges = build_edges(tasks)
      removed = []

      tasks.each do |task|
        pos = task["position"].to_i
        deps = Array(task["depends_on"]).map(&:to_i)
        next if deps.size < 2

        # For each direct edge pos -> dep, check if another direct
        # predecessor transitively reaches dep. If so, the pos -> dep
        # edge is implied and can be dropped.
        to_prune = deps.select do |dep|
          others = deps - [dep]
          others.any? { |other| reaches?(other, dep, edges) }
        end

        next if to_prune.empty?

        removed << { position: pos, pruned: to_prune }
        task["depends_on"] = deps - to_prune
      end

      removed
    end

    # Internal: build a { position => [prereq positions] } adjacency map.
    def self.build_edges(tasks)
      tasks.each_with_object({}) do |task, h|
        pos = task["position"].to_i
        h[pos] = Array(task["depends_on"]).map(&:to_i)
      end
    end

    # Internal: depth-first search for a cycle. `path` is the current
    # gray-colored stack. On finding a back-edge, return the cycle as
    # [back-target, ...nodes-in-cycle..., back-target] so it's
    # unambiguously readable in the error message.
    def self.dfs_cycle(node, edges, colors, path)
      colors[node] = :gray
      path.push(node)

      Array(edges[node]).each do |next_node|
        if colors[next_node] == :gray
          # Back-edge — construct the cycle slice
          idx = path.index(next_node)
          return path[idx..] + [next_node] if idx
          return [next_node, node, next_node]
        elsif colors[next_node].nil?
          result = dfs_cycle(next_node, edges, colors, path)
          return result if result
        end
      end

      path.pop
      colors[node] = :black
      nil
    end

    # Internal: BFS — does there exist a path from `from` to `to` by
    # following depends_on edges? Returns true when `to` is a transitive
    # prerequisite of `from`. A node trivially reaches itself only if
    # it's explicitly in its own prerequisite chain (would already be a
    # cycle, caught by assert_acyclic! upstream).
    def self.reaches?(from, to, edges)
      return false if from == to
      queue = [from]
      seen = Set.new
      until queue.empty?
        node = queue.shift
        next if seen.include?(node)
        seen << node
        Array(edges[node]).each do |prereq|
          return true if prereq == to
          queue << prereq
        end
      end
      false
    end
  end
end
