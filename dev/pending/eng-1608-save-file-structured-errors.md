## ENG-1608: save_file structured handler errors (2026-10-11)

save_file validates file_name/file_content before any storage write and returns `error_code` (MISSING_FILE_NAME, INVALID_FILE_NAME, MISSING_FILE_CONTENT, INVALID_FILE_CONTENT, EMPTY_FILE_CONTENT, FILE_TOO_LARGE, STORAGE_WRITE_FAILED) plus an actionable message. Success payload unchanged.
