#!/usr/bin/env node
/**
 * Database Health Check Script
 *
 * This script checks if all required database tables exist.
 * If any tables are missing, it automatically runs migrations.
 *
 * Run this before starting the dev server to ensure database is ready.
 */

import { execSync } from 'child_process'

const REQUIRED_TABLES = [
  'users',
  'trees',
  'tree_members',
  'nodes',
  'node_relations',
  'invitations',
  'notifications',
  'sessions'
]

function parseWranglerJsonArray(raw) {
  const match = raw.match(/\[\s*\{[\s\S]*\}\s*\]/)
  if (!match) return null
  return JSON.parse(match[0])
}

console.log('🔍 Checking database health...')

try {
  // Check which tables exist
  const result = execSync(
    'npx wrangler d1 execute zeeta2-production --local --command "SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name;"',
    { encoding: 'utf-8', stdio: 'pipe' }
  )

  const data = parseWranglerJsonArray(result)
  if (!data) {
    console.error('❌ Failed to parse database response')
    process.exit(1)
  }
  const existingTables = data[0]?.results?.map(row => row.name) || []

  // Check if all required tables exist
  const missingTables = REQUIRED_TABLES.filter(table => !existingTables.includes(table))

  if (missingTables.length === 0) {
    console.log('✅ Database is healthy. All required tables exist.')
  } else {
    console.warn(`⚠️  Missing tables: ${missingTables.join(', ')}`)
    console.log('🔧 Running migrations...')

    // Run migrations
    execSync('npm run db:migrate:local', { stdio: 'inherit' })

    console.log('✅ Migrations completed successfully.')
  }

  // Seed initial data when tree data is effectively empty.
  const countResult = execSync(
    'npx wrangler d1 execute zeeta2-production --local --command "SELECT COUNT(*) AS cnt FROM trees;"',
    { encoding: 'utf-8', stdio: 'pipe' }
  )
  const countData = parseWranglerJsonArray(countResult)
  if (!countData) {
    console.error('❌ Failed to parse tree count response')
    process.exit(1)
  }
  const treeCount = Number(countData[0]?.results?.[0]?.cnt || 0)

  // "visibleNodeCount" checks whether any root has at least one child relation.
  const visibleResult = execSync(
    'npx wrangler d1 execute zeeta2-production --local --command "SELECT COUNT(*) AS cnt FROM node_relations nr INNER JOIN trees t ON t.root_node_id = nr.parent_node_id;"',
    { encoding: 'utf-8', stdio: 'pipe' }
  )
  const visibleData = parseWranglerJsonArray(visibleResult)
  if (!visibleData) {
    console.error('❌ Failed to parse visible node count response')
    process.exit(1)
  }
  const visibleNodeCount = Number(visibleData[0]?.results?.[0]?.cnt || 0)

  if (treeCount === 0 || visibleNodeCount === 0) {
    console.log(`🌱 Seeding development data (trees=${treeCount}, root_children=${visibleNodeCount})...`)
    execSync('npm run db:seed', { stdio: 'inherit' })
    console.log('✅ Seed data created.')
  } else {
    console.log(`ℹ️  Tree data exists (trees=${treeCount}, root_children=${visibleNodeCount}). Skip seeding.`)
  }

  process.exit(0)

} catch (error) {
  console.error('❌ Database health check failed:', error.message)
  console.log('💡 Tip: Run "npm run db:migrate:local" manually to fix database issues.')
  process.exit(1)
}
