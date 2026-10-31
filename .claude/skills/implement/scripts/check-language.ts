/**
 * Ubiquitous language in the code: flags words that CONTEXT.md lists under `_Avoid_`
 *   - in message catalog values (files in messages/, locales/ or i18n/ starting with the artifact language)
 *   - in identifiers declared in application code (generic programming words like "id" or "type" are skipped)
 *
 * Advisory: findings are warnings and never fail the build. A line containing `language-ok` is skipped
 * (e.g. a third-party library's `user` object).
 *
 * Usage: node check-language.ts
 */
import * as e from "../../../lib/engineering.ts";

const findings = e.languageFindings();
for (const f of findings) console.log(`WARNING  ${f.file} (${f.where}): '${f.word}' – the glossary says '${f.preferred}'`);
console.log(findings.length ? `${findings.length} language warning(s).` : "Glossary language OK.");
