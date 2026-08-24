import { Buffer } from "node:buffer";

import {
  parseSkillMarkdown,
  type SkillDefinition,
  type SkillSummary,
} from "./format.js";

export type AvailableSkillSource = "built-in" | "user";

export interface AvailableSkillSummary extends SkillSummary {
  source: AvailableSkillSource;
}

const builtInSkillMarkdown = [
  `---
name: arranging-section-energy
description: Use when repeated song sections feel flat, transitions lack direction, or an Arrangement needs a clearer energy arc.
---

# Arranging Section Energy

## Principle

Create direction by controlling when existing musical roles enter, leave, thin out, and return. Treat layer count and role changes as **arrangement-energy proxies**; do not claim they prove loudness, intensity, or emotional effect when audio has not been heard.

## Build the Arc

1. Separate observations from unknowns. Record confirmed section, Clip, and phrase boundaries; list any unheard content, unclear role, or unobserved transition.
2. Define at least three states using existing roles: foundation, build, peak, reset, or equivalent. A state must say what plays, what rests, and what the change prepares.
3. Place changes only on confirmed musical boundaries. If only 8-bar Clip boundaries are known, keep the plan on those boundaries. Do not invent 1-, 2-, or 4-bar cuts, fills, pickups, fades, or automation. State what additional observation would make a finer edit safe.
4. Preserve one anchor through most transitions, such as drums, bass, chords, or a recurring motif. Change one or two roles at a time so the listener can perceive the new state.
5. Give each payoff a setup. Before a full return, subtract or withhold a role; after a peak, create enough contrast to make the next build meaningful. Avoid both constant full density and mechanical layer-only accumulation.
6. Prefer reversible use of existing Clip instances. Keep source content, start offsets, loop settings, harmony, and device parameters unchanged unless the user separately authorizes and the required state has been observed.

## Response Contract

Provide:

- a short **Observed / Unknown** boundary statement;
- a bar-aligned table with state, active/resting roles, and purpose;
- the setup and payoff relationship for each major transition;
- a reversible execution order using only supported, observed operations;
- when the following section's role is unknown, one conditional branch for that boundary.

## Common Mistakes

- Treating more tracks as proof of greater loudness or excitement.
- Cutting inside an unheard Clip because the user requested bar-level detail.
- Bringing every role in early and leaving no later payoff.
- Recommending EQ, compression, new sounds, or rewritten harmony for an arrangement-only request.
- Describing an imagined riser, fill, vocal phrase, or timbral change as observed fact.

This Skill governs macro section order and energy. It does not design motif variations, assign simultaneous instrument roles, or make mixing decisions.
`,
  `---
name: developing-musical-variation
description: Use when a motif or loop repeats too literally, later phrases need controlled development, or variation must preserve a recognizable musical identity.
---

# Developing Musical Variation

## Principle

Variation is a controlled difference around a stated invariant. Preserve enough of the observed motif for recognition, change one musical dimension at a time, and schedule a return so development does not become random rewriting.

## Define Identity Before Editing

From observed notes, state the motif's fingerprint:

- phrase and repetition boundaries;
- onset rhythm and duration pattern;
- interval contour or exact pitches;
- accent pattern and phrase ending.

Choose at least two properties as **invariants** and one as the current **variable**. When harmony is unknown, keep pitches and onsets invariant; do not invent chord tones, passing notes, countermelodies, or harmonic labels.

Confirm that each target repetition is independently editable. Change one repetition only when the current action schema offers a reversible way to create an independent instance; otherwise stop and report the missing capability. Preserve an untouched original.

## Variation Ladder

Plan at confirmed motif or phrase boundaries:

1. **Statement:** present the original fingerprint unchanged.
2. **Single change:** alter one dimension on one later statement—velocity/accent, duration/articulation, density, register, or an observed phrase ending.
3. **Development:** either intensify that same dimension or return it and test one different dimension. Do not stack new pitch, rhythm, duration, velocity, and octave rules at once.
4. **Return:** restate the original or near-original fingerprint after the strongest variation. Make the exact return bar explicit.

Use deterministic note-selection rules tied to observed structure, such as “the final onset group of each confirmed 4-bar motif.” Avoid arbitrary percentages for every bar when one phrase-level contrast communicates the idea.

Apply one version, re-observe, and compare it with the untouched statement before advancing. If the motif is no longer recognizable, restore an invariant or reduce the transformation.

## Response Contract

Provide:

- the observed motif fingerprint and unknown musical context;
- an explicit invariant/variable table;
- a bar-aligned Statement → Change → Development → Return map;
- one transformation per stage with an exact note-selection rule;
- the independent-copy and rollback plan;
- a recognition check comparing each variation with the original.

## Common Mistakes

- Changing pitch, duration, velocity, octave, and density in the same pass.
- Varying every bar so no stable statement remains.
- Building to a final maximum without a return point.
- Editing a loop source and unintentionally changing every repetition.
- Guessing harmony, safe chord tones, or phrase meaning from note data alone.

This Skill develops material inside a phrase or repeated loop. It does not design macro section energy, organize simultaneous instrument roles, or make mixing decisions.
`,
  `---
name: organizing-instrument-roles
description: Use when too many parts compete at once, a focal part lacks space, or an Arrangement needs clearer foreground, support, and motion roles.
---

# Organizing Instrument Roles

## Principle

Improve clarity by reducing simultaneous role, register, and rhythm occupancy before reaching for mixing. MIDI overlap is evidence of **arrangement competition risk**, not proof of audible masking when audio, levels, and timbre are unknown.

## Assign Roles First

Create a role ledger for the target passage:

- **Focus:** the one part that must read first.
- **Anchor:** the pulse, bass, or harmony that keeps the passage grounded.
- **Motion:** the minimum part needed to preserve forward movement.
- **Support:** sustained or punctuating context.
- **Ornament:** optional detail that can leave without weakening the idea.

Give each part one primary role. Two parts with the same register, rhythm density, and role are the first candidates for alternation or removal.

## Least-Change Ladder

Work one pass at a time and re-observe before advancing:

1. **Remove duplicate occupancy.** Mute or alternate one redundant part for a confirmed phrase; keep one anchor and one motion source.
2. **Separate in time.** Let support answer the focus or occupy observed gaps. Do not invent vocal rests, phrase boundaries, or transition fills.
3. **Reduce rhythm density.** Remove selected attacks around observed focus onsets while preserving the part's defining pulse.
4. **Separate register.** Change notes only when pitches, harmony, destination range, and device range are observed. Prefer octave displacement of existing notes; never invent chord tones.
5. **Rewrite material last.** Change several parts only after an earlier isolated pass failed.

Do not change role count, rhythm, register, and phrase structure across every part in one operation. Such a batch prevents causal A/B comparison and can replace one competition problem with another.

## Response Contract

Provide:

- **Observed overlap / Unverified hearing** as separate statements;
- a role table for every active part;
- **Pass A**, the smallest reversible change and its measurable MIDI/Clip result;
- optional Pass B and C, each conditional on the previous A/B result;
- exact observed boundaries or a request for the missing boundary/onset data;
- a check that one anchor, one motion source, and the focal part remain.

## Common Mistakes

- Recommending EQ, compression, panning, or new tracks for an arrangement-only request.
- Transposing several parts to guessed chord tones or unverified safe ranges.
- Editing every accompaniment simultaneously.
- Clearing all rhythmic motion to make room for the focus.
- Treating track names as proof of musical function.

This Skill governs simultaneous instrument roles and density. It does not design the song's section arc, develop motifs, or prescribe mixing settings.
`,
] as const;

const definitions = builtInSkillMarkdown.map((source) =>
  parseSkillMarkdown(Buffer.from(source, "utf8"))
).sort(compareSkillIds);

const definitionsById = new Map(
  definitions.map((definition) => [definition.id, definition] as const),
);

export function builtInSkillDefinitions(): SkillDefinition[] {
  return definitions.map(cloneSkillDefinition);
}

export function builtInSkillDefinition(
  skillId: string,
): SkillDefinition | undefined {
  const definition = definitionsById.get(skillId);
  return definition === undefined ? undefined : cloneSkillDefinition(definition);
}

export function isBuiltInSkillId(skillId: string): boolean {
  return definitionsById.has(skillId);
}

export function availableSkillSummaries(
  installed: readonly SkillSummary[],
): AvailableSkillSummary[] {
  const installedIds = new Set(installed.map((skill) => skill.id));
  return [
    ...definitions
      .filter((skill) => !installedIds.has(skill.id))
      .map(({ id, description }) => ({
        id,
        description,
        source: "built-in" as const,
      })),
    ...installed.map(({ id, description }) => ({
      id,
      description,
      source: "user" as const,
    })),
  ].sort(compareSkillIds);
}

function cloneSkillDefinition(definition: SkillDefinition): SkillDefinition {
  return { ...definition };
}

function compareSkillIds(
  left: { id: string },
  right: { id: string },
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
