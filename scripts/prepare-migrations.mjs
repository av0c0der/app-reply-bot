#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config(); // Load .env

const schemaName = process.env.DATABASE_SCHEMA || 'reviews_bot';
const templatesDir = join(__dirname, '../supabase/migrations-templates');
const outputDir = join(__dirname, '../supabase/migrations');

console.log(`Preparing migrations with schema: ${schemaName}`);

// Create output directory
mkdirSync(outputDir, { recursive: true });

// Template files mapping
const templates = [
  { source: 'schema.template.sql', output: 'schema.sql' },
  { source: 'reset.template.sql', output: 'reset.sql' }
];

// Process each template
templates.forEach(({ source, output }) => {
  const sourcePath = join(templatesDir, source);
  const outputPath = join(outputDir, output);

  const template = readFileSync(sourcePath, 'utf8');
  const processed = template.replace(/\{\{SCHEMA_NAME\}\}/g, schemaName);

  writeFileSync(outputPath, processed, 'utf8');
  console.log(`✓ Generated ${output}`);
});

console.log(`\n✅ Migrations ready in: supabase/migrations/`);
console.log(`Schema: ${schemaName}\n`);
console.log('Next steps:');
console.log('1. Copy the contents of each file to Supabase SQL Editor');
console.log('2. Execute: schema.sql');
console.log('3. (Optional) To reset, use: reset.sql');
