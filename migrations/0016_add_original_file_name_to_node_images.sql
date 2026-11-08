-- Keep original uploaded filename for UI tooltip / traceability

ALTER TABLE node_images ADD COLUMN original_file_name TEXT;
