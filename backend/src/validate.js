'use strict';

const { z } = require('zod');

/** Express helper: parse with a zod schema or answer 400 with a readable message. */
function parse(schema, data, res) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.') || 'input';
    res.status(400).json({ success: false, message: `${field}: ${issue.message}` });
    return null;
  }
  return result.data;
}

const optionalNumber = (schema) =>
  z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : v), schema.optional());

module.exports = { z, parse, optionalNumber };
