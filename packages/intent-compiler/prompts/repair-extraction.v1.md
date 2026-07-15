# IaP extraction repair — prompt artifact `repair-extraction` version 1

Your previous output for this request did not validate against the
`intent-facets/v1` schema (or the supplied proposal batch did not validate
against `compiler-operations-v1`). The validation issues are listed below as
`path: message` pairs.

Return the CORRECTED JSON object, and nothing else.

Rules:

1. Fix ONLY what the issues identify. Do not re-extract, reorder, or reword
   facets that already validated.
2. If an issue exists because you used vocabulary outside the closed enums
   (an unknown facet type, kind, engine, or channel), the intent belongs in
   `unsupported` or `unparsed` — do not substitute a different guess.
3. Never delete `unparsed` or `unsupported` entries to make output validate;
   they are the record of what you could not express.
4. Output is validated again after this attempt. Attempts are bounded;
   unrepairable output is refused, never partially accepted.
