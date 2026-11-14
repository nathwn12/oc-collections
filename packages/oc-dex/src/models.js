const QUALIFIED_ID = /^([a-z0-9][a-z0-9.-]*)\/(.+)$/;

export function splitModelID(value) {
  if (typeof value !== "string") throw new Error("invalid model ID");
  const match = QUALIFIED_ID.exec(value);
  if (!match || match[2].includes("#")) throw new Error(`invalid model ID: ${value}`);
  return { id: value, providerID: match[1], modelID: match[2] };
}

export function catalogIDs(catalog) {
  const entries = Array.isArray(catalog) ? catalog : catalog?.data;
  if (!Array.isArray(entries)) throw new Error("Invalid OpenCode model catalog");
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.providerID !== "string") {
      throw new Error("Invalid OpenCode model catalog entry");
    }
    if (entry.providerID !== "opencode-go") continue;
    if (typeof (entry.modelID ?? entry.id) !== "string" || (entry.id !== undefined && typeof entry.id !== "string")) {
      throw new Error("Invalid OpenCode model catalog entry");
    }
    const { id } = splitModelID(`${entry.providerID}/${entry.modelID ?? entry.id}`);
    ids.add(id);
  }
  return ids;
}

export function normalizeOptions(options, catalog) {
  const ids = catalog instanceof Set ? catalog : catalogIDs(catalog);
  const qualify = value => {
    const id = value.includes("/") ? value : `opencode-go/${value}`;
    const model = splitModelID(id);
    if (model.providerID !== "opencode-go") {
      throw new Error(`model must use the OpenCode Go provider: ${model.id}`);
    }
    if (!ids.has(model.id)) throw new Error(`model is not in the OpenCode Go catalog: ${model.id}`);
    return model.id;
  };
  const normalized = options.models.map(qualify);
  if (new Set(normalized).size !== normalized.length) throw new Error("models contains duplicate IDs after provider qualification");
  const models = normalized;
  const requestedDefault = qualify(options.defaultModel);
  return { ...options, models, defaultModel: models.includes(requestedDefault) ? requestedDefault : models[0] };
}

export function resolveModel(value, catalog, allowlist) {
  const model = splitModelID(value);
  if (model.providerID !== "opencode-go") {
    throw new Error(`model must use the OpenCode Go provider: ${model.id}`);
  }
  const ids = catalog instanceof Set ? catalog : catalogIDs(catalog);
  if (!Array.isArray(allowlist) || !allowlist.includes(model.id)) {
    throw new Error(`model is not in the configured allowlist: ${model.id}`);
  }
  return model;
}
