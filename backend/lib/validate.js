/* =================================================================
   Souqi — tiny schema validator (dependency-free)
   -----------------------------------------------------------------
   A small, explicit validator used to sanitize request bodies before
   they reach a handler. It:
     • enforces types, required, min/max, enum, email,
     • strips unknown keys (mass-assignment protection),
     • coerces numbers,
   and produces a clean `req.valid` object. On failure it raises a
   400 validation_error through the standard error envelope.

   Schema shape:  { fields: { <key>: <spec> } }
   Spec:          { type, required, min, max, enum, email, of, fields, default }
   Types:         "string" | "number" | "email" | "array" | "object"
   ================================================================= */
"use strict";
const { httpError } = require("./errors");

function isEmail(s) {
  return typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function checkField(path, spec, value, errors) {
  const present = value !== undefined && value !== null && value !== "";
  if (!present) {
    if (spec.required) errors.push(path + " is required");
    return spec.default;
  }
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") { errors.push(path + " must be a string"); return undefined; }
      if (spec.min != null && value.length < spec.min) errors.push(path + " is too short");
      if (spec.max != null && value.length > spec.max) errors.push(path + " is too long");
      if (spec.enum && spec.enum.indexOf(value) === -1) errors.push(path + " is not an allowed value");
      return value;
    case "email":
      if (!isEmail(value)) errors.push(path + " must be a valid email");
      return typeof value === "string" ? value.toLowerCase() : undefined;
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) { errors.push(path + " must be a number"); return undefined; }
      if (spec.min != null && n < spec.min) errors.push(path + " is below the minimum");
      if (spec.max != null && n > spec.max) errors.push(path + " is above the maximum");
      return n;
    }
    case "array":
      if (!Array.isArray(value)) { errors.push(path + " must be an array"); return undefined; }
      if (spec.min != null && value.length < spec.min) errors.push(path + " needs at least " + spec.min + " item(s)");
      if (spec.max != null && value.length > spec.max) errors.push(path + " has too many items");
      if (spec.of) return value.map((v, i) => validateAgainst(path + "[" + i + "]", spec.of, v, errors));
      return value;
    case "object":
      if (typeof value !== "object" || Array.isArray(value)) { errors.push(path + " must be an object"); return undefined; }
      if (spec.fields) return pick(path, spec.fields, value, errors);
      return value;
    default:
      return value;
  }
}

function validateAgainst(path, spec, value, errors) {
  if (spec.type === "object" && spec.fields) return checkField(path, spec, value || {}, errors);
  return checkField(path, spec, value, errors);
}

function pick(basePath, fields, data, errors) {
  const out = {};
  const src = data && typeof data === "object" ? data : {};
  for (const key of Object.keys(fields)) {
    const p = basePath ? basePath + "." + key : key;
    const v = checkField(p, fields[key], src[key], errors);
    if (v !== undefined) out[key] = v; // unknown keys are never copied
  }
  return out;
}

/** Validate+sanitize `data` against a schema. Returns { ok, value, errors }. */
function validate(schema, data) {
  const errors = [];
  const value = pick("", schema.fields, data, errors);
  return { ok: errors.length === 0, value, errors };
}

/** Express middleware: validates req.body, sets req.valid, else 400. */
function validateBody(schema) {
  return function (req, res, next) {
    const { ok, value, errors } = validate(schema, req.body);
    if (!ok) return next(httpError(400, "validation_error", errors.join("; ")));
    req.valid = value;
    next();
  };
}

module.exports = { validate, validateBody, isEmail };
