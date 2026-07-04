-- Service logs for analytics and audit trail
CREATE TABLE IF NOT EXISTS service_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  service_type TEXT NOT NULL,
  provider TEXT,
  action TEXT NOT NULL CHECK (action IN ('view', 'attempt', 'success', 'failure')),
  metadata JSONB,
  network_type TEXT,
  device_info TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE service_logs ENABLE ROW LEVEL SECURITY;

-- Users can insert their own logs
CREATE POLICY "Users can insert own logs" ON service_logs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can view their own logs
CREATE POLICY "Users can view own logs" ON service_logs
  FOR SELECT USING (auth.uid() = user_id);

-- Index for fast queries
CREATE INDEX idx_service_logs_user_id ON service_logs(user_id);
CREATE INDEX idx_service_logs_service_type ON service_logs(service_type);
CREATE INDEX idx_service_logs_created_at ON service_logs(created_at DESC);
CREATE INDEX idx_service_logs_provider ON service_logs(provider);
