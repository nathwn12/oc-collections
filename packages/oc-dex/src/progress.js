// Progress display policy. OpenCode accepts any JSON object as `context.progress` metadata,
// so the shape below is ours to keep small: one title, one status line, and the fields a
// client needs to redraw a clock. Verbosity is a policy, not a pile of flags at the call site.
export const PROGRESS_MODES = ["quiet", "concise", "detailed"];

const POLICIES = {
  // Heartbeat only: the clock keeps moving, nothing else rides along.
  quiet: { detail: false, onEvent: false, model: false },
  // Phase and clock: a status that only changes when the run changes phase.
  concise: { detail: false, onEvent: true, model: false },
  // Everything the controller knows, for someone debugging a stuck run.
  detailed: { detail: true, onEvent: true, model: true },
};

const DETAIL_LIMIT = 120;

function clean(value, limit = DETAIL_LIMIT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : text.slice(0, limit).trimEnd();
}

export function progressPolicy(mode = "concise") {
  const policy = POLICIES[mode];
  if (!policy) throw new Error(`progress must be one of: ${PROGRESS_MODES.join(", ")}`);
  return policy;
}

// The payload every mode sends. Modes differ in what reaches `status`, never in whether the
// caller can see the run moving.
export function formatProgress({ mode = "concise", startedAt, at = Date.now(), stage, detail, model }) {
  const policy = progressPolicy(mode);
  const elapsedSeconds = Math.max(0, Math.floor((at - startedAt) / 1000));
  const phase = clean(stage) || "starting";
  const tail = policy.detail ? clean(detail) : "";
  const suffix = `${elapsedSeconds}s`;
  return {
    title: policy.model && model ? `oc-dex · ${model}` : "oc-dex",
    status: [phase, ...(tail && tail !== suffix ? [tail] : []), suffix].join(" · "),
    stage: phase,
    elapsedSeconds,
  };
}
