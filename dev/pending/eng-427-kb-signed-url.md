## ENG-427: list_knowledge_base_files returns signed URL for private KBs (2026-10-06)

getTasksWithKnowledgeBase now keeps the `knowledgeBase` signed URL in its projection, so the KB listing no longer returns url:null for private/org knowledge-base.txt files.
