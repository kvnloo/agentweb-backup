/**
 * ENG-2840 (W2-1): how many memory rows one read may return. No imports, so the routes and the db layer can share it without
 * either loading the other.
 *
 * A memory row carries a 1,536-number embedding, about 17 KB, and a DynamoDB query page holds at most 1 MB, so one page is 56 to
 * 60 rows. Before W2-1 both readers stopped after the first page: an account with more memories than that (14 of 52 accounts on
 * 2026-11-23, the largest with 277) only ever showed its OLDEST ~56 to Emma and to the portal list, and every memory saved after
 * them was invisible. A read now follows the cursor up to a bound:
 *   - the prompt loader reads the newest 200 (it runs on every agent turn, so it stays bounded);
 *   - the portal lists read up to 1,000, oldest first as before, without the embedding vectors.
 */
export const MEMORY_READ_MAX_ROWS_PROMPT = 200;
export const MEMORY_READ_MAX_ROWS_LIST = 1000;
