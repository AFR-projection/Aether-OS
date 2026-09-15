-- Aether Cloud OS - Database Initialization Script
-- This script runs automatically when the PostgreSQL container starts

-- Create extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create initial schema
CREATE SCHEMA IF NOT EXISTS aether;

-- Set default search path
ALTER DATABASE aether_dev SET search_path TO aether, public;

-- Create users table (placeholder for Phase 1)
CREATE TABLE IF NOT EXISTS aether.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create sessions table (placeholder for Phase 1)
CREATE TABLE IF NOT EXISTS aether.sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES aether.users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON aether.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON aether.sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON aether.sessions(expires_at);

-- Insert development user (password: "dev123")
INSERT INTO aether.users (username, email, password_hash)
VALUES (
    'dev',
    'dev@aether-os.local',
    crypt('dev123', gen_salt('bf'))
)
ON CONFLICT (username) DO NOTHING;

-- Grant permissions
GRANT ALL PRIVILEGES ON SCHEMA aether TO aether;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA aether TO aether;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA aether TO aether;

-- Log completion
DO $$
BEGIN
    RAISE NOTICE 'Aether Cloud OS database initialized successfully';
END $$;
