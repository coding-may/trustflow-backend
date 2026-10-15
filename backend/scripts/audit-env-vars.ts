#!/usr/bin/env tsx
/**
 * Audits environment variable coverage between .env.example and env.config.ts
 *
 * Ensures that:
 * 1. Every variable in EnvSchema is documented in .env.example
 * 2. Every variable in .env.example is defined in EnvSchema
 * 3. No drift between configuration and documentation
 *
 * Used in CI to block PRs that introduce undocumented config or orphaned examples.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = join(__dirname, '..');
const ENV_CONFIG_PATH = join(PROJECT_ROOT, 'src/config/env.config.ts');
const ENV_EXAMPLE_PATH = join(PROJECT_ROOT, '..', '.env.example');

interface AuditResult {
  success: boolean;
  missingInExample: string[];
  missingInSchema: string[];
  errors: string[];
}

function extractSchemaVars(configContent: string): Set<string> {
  const vars = new Set<string>();
  
  // Match variable names in the EnvSchema object definition
  // Handles patterns like: VARIABLE_NAME: z.string()...
  const schemaMatch = configContent.match(/const EnvSchema = z\.object\(\{([\s\S]*?)\}\)/);
  
  if (!schemaMatch) {
    throw new Error('Could not find EnvSchema definition in env.config.ts');
  }
  
  const schemaBody = schemaMatch[1];
  const varPattern = /^\s*([A-Z][A-Z0-9_]*)\s*:/gm;
  let match;
  
  while ((match = varPattern.exec(schemaBody)) !== null) {
    vars.add(match[1]);
  }
  
  return vars;
}

function extractExampleVars(exampleContent: string): Set<string> {
  const vars = new Set<string>();
  
  // Match variable names in .env.example (KEY=value or KEY= or # KEY=value)
  const lines = exampleContent.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) {
      // But check for commented-out variable definitions
      const commentedVar = trimmed.match(/^#\s*([A-Z][A-Z0-9_]*)\s*=/);
      if (commentedVar) {
        vars.add(commentedVar[1]);
      }
      continue;
    }
    
    // Extract variable name from KEY=value
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=/);
    if (match) {
      vars.add(match[1]);
    }
  }
  
  return vars;
}

function audit(): AuditResult {
  const result: AuditResult = {
    success: true,
    missingInExample: [],
    missingInSchema: [],
    errors: [],
  };
  
  try {
    const configContent = readFileSync(ENV_CONFIG_PATH, 'utf-8');
    const exampleContent = readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
    
    const schemaVars = extractSchemaVars(configContent);
    const exampleVars = extractExampleVars(exampleContent);
    
    // Check for variables in schema but not in example
    for (const varName of schemaVars) {
      if (!exampleVars.has(varName)) {
        result.missingInExample.push(varName);
        result.success = false;
      }
    }
    
    // Check for variables in example but not in schema
    for (const varName of exampleVars) {
      if (!schemaVars.has(varName)) {
        result.missingInSchema.push(varName);
        result.success = false;
      }
    }
    
  } catch (error) {
    result.success = false;
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  
  return result;
}

function main() {
  console.log('🔍 Auditing environment variable coverage...\n');
  
  const result = audit();
  
  if (result.errors.length > 0) {
    console.error('❌ Audit failed with errors:');
    result.errors.forEach(err => console.error(`   ${err}`));
    process.exit(1);
  }
  
  if (result.missingInExample.length > 0) {
    console.error('❌ Variables defined in EnvSchema but missing from .env.example:');
    result.missingInExample.forEach(v => console.error(`   ${v}`));
    console.error('\nAdd these variables to .env.example with appropriate default/placeholder values.\n');
  }
  
  if (result.missingInSchema.length > 0) {
    console.error('❌ Variables in .env.example but not defined in EnvSchema:');
    result.missingInSchema.forEach(v => console.error(`   ${v}`));
    console.error('\nEither add these to EnvSchema or remove them from .env.example.\n');
  }
  
  if (result.success) {
    console.log('✅ All environment variables are properly documented');
    console.log('✅ .env.example is in sync with env.config.ts\n');
    process.exit(0);
  } else {
    console.error('❌ Environment variable audit failed');
    console.error('Fix the above issues to ensure configuration stays documented.\n');
    process.exit(1);
  }
}

main();
