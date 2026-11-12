/**
 * ENG-2947: analyze usage-alert outcomes from an exported log file.
 * Usage: npx ts-node scripts/analyze-usage-alert-outcomes.ts <log-export.txt|-> 
 * Read-only: reads a local file or stdin, prints a JSON report. No AWS calls.
 */
import { readFileSync } from "fs";
import { analyzeUsageAlertOutcomes } from "../src/services/usageAlertOutcomeAnalysis";

const path = process.argv[2];
if (!path) {
  console.error("usage: analyze-usage-alert-outcomes.ts <log-export-file|->");
  process.exit(2);
}
const text = readFileSync(path === "-" ? 0 : path, "utf8");
console.log(JSON.stringify(analyzeUsageAlertOutcomes(text.split(/\r?\n/)), null, 2));
