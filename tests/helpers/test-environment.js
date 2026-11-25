const servers = JSON.parse(process.env.ZEETA_TEST_SERVERS || '[]')
const server = servers[Number(process.env.TEST_PARALLEL_INDEX || 0)]

export const TEST_BASE_URL = server?.baseURL || process.env.ZEETA_TEST_BASE_URL || 'http://localhost:3000'
export const TEST_DB_PATH = server?.dbPath || process.env.ZEETA_TEST_DB_PATH
export const TEST_STATE_PATH = server?.state || process.env.ZEETA_TEST_STATE_PATH
