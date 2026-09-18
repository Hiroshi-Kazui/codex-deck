// JSON Schemas are shared by the CLI response format and local validation.
const string = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: string };
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const resultSchema = object({
  status: { enum: ['complete', 'blocked'] }, summary: string, files: strings,
  tests: strings, blockers: strings, handoff: string,
});
export const reviewSchema = object({
  status: { enum: ['pass', 'fail'] }, summary: string,
  criteria: { type: 'array', items: object({ id: string, satisfied: { type: 'boolean' }, evidence: string }) },
  findings: { type: 'array', items: object({ severity: { enum: ['blocking', 'followup'] }, criterion: string, location: string, problem: string, impact: string, fix: string, verification: string }) },
});
export const diagnosisSchema = object({ cause: string, correction: string, requiresDecision: { type: 'boolean' }, question: { type: 'string' } });
export const configSchema = object({
  version: { const: 1 }, referenceRoot: string,
  models: object({ implement: string, review: string, critical: string, diagnose: string }),
  limits: object(Object.fromEntries(['agentMs', 'checkMs', 'runMs', 'fixes', 'transientRetries'].map(k => [k, { type: 'integer', minimum: k.endsWith('Ms') ? 1 : 0 }]))),
  codexPath: { type: ['string', 'null'] },
});
export const tasksSchema = { type: 'array', minItems: 1, items: object({
  id: string, milestone: { enum: ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6'] }, title: string,
  dependsOn: strings, critical: { type: 'boolean' }, reads: strings, scope: strings,
  criteria: { type: 'array', minItems: 1, items: object({ id: string, text: string }) },
  checks: { type: 'array', minItems: 1, items: object({ name: string, command: { type: 'array', minItems: 1, items: string }, criteria: strings }) },
}) };
export function validate(schema, value) {
  // Deliberately closed subset used by our own schemas, NOT a general JSON Schema implementation.
  const known = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minLength', 'minItems', 'minimum']);
  function check(s, v, location) {
    for (const key of Object.keys(s)) if (!known.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    const fail = message => { throw new Error(`Schema validation failed at ${location}: ${message}`); };
    const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some(t => t === type || (t === 'integer' && Number.isInteger(v)))) fail(`expected ${types.join('|')}, got ${type}`);
    }
    if ('const' in s && v !== s.const) fail('incorrect constant');
    if (s.enum && !s.enum.includes(v)) fail('not in enum');
    if (typeof v === 'number' && (!Number.isFinite(v) || ('minimum' in s && v < s.minimum))) fail('number below minimum or non-finite');
    if (typeof v === 'string' && 'minLength' in s && v.length < s.minLength) fail('string too short');
    if (Array.isArray(v)) {
      if ('minItems' in s && v.length < s.minItems) fail('array too short');
      if (s.items) v.forEach((item, i) => check(s.items, item, `${location}[${i}]`));
    }
    if (type === 'object') {
      for (const key of s.required ?? []) if (!Object.hasOwn(v, key)) fail(`missing ${key}`);
      for (const [key, item] of Object.entries(v)) {
        if (s.properties && Object.hasOwn(s.properties, key)) check(s.properties[key], item, `${location}.${key}`);
        else if (s.additionalProperties === false) fail(`unexpected ${key}`);
      }
    }
  }
  check(schema, value, '$');
  return value;
}
export function reviewPass(review, task) {
  validate(reviewSchema, review);
  const ids = review.criteria.map(c => c.id);
  if (new Set(ids).size !== ids.length || ids.length !== task.criteria.length || ids.some(id => !task.criteria.some(c => c.id === id))) return false;
  return review.status === 'pass' && review.criteria.every(c => c.satisfied) && !review.findings.some(f => f.severity === 'blocking');
}
