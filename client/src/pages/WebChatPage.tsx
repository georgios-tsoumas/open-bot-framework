import React, { useState } from 'react';
import { Plus, Trash2, Copy, Eye, EyeOff } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useFetch } from '@/hooks/useFetch';
import { apiClient } from '@/services/api';
import { Card, Button, LoadingSpinner, Alert, Modal, Input } from '@/components';
import { WebChatChannel } from '@/types';

export const WebChatPage: React.FC = () => {
  const { botId = '' } = useParams();
  const navigate = useNavigate();

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { data, loading, error: loadError, refetch } = useFetch(
    () => apiClient.getWebChatChannels(botId, 0, 100),
    [botId]
  );

  const create = async () => {
    if (!form.name) {
      setError('Name is required');
      return;
    }
    setBusy(true);
    try {
      await apiClient.createWebChatChannel(botId, { name: form.name });
      setSuccess('Channel created');
      setForm({ name: '' });
      setCreateOpen(false);
      await refetch();
    } catch (err) {
      setError((err as Error).message || 'Failed to create');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('Delete this channel?')) return;
    try {
      await apiClient.deleteWebChatChannel(botId, id);
      setSuccess('Channel deleted');
      await refetch();
    } catch (err) {
      setError((err as Error).message || 'Failed to delete');
    }
  };

  const toggleReveal = (k: string) =>
    setRevealed((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const copy = (val: string, k: string) => {
    navigator.clipboard.writeText(val);
    setCopiedKey(k);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <button
            onClick={() => navigate(`/bots/${botId}`)}
            className="text-xs text-content-muted hover:text-content mb-2"
          >
            ← Back to bot
          </button>
          <h1 className="text-2xl font-semibold text-content">WebChat channels</h1>
          <p className="text-sm text-content-muted mt-1">
            Embed channels with rotating secret pairs
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New channel
        </Button>
      </div>

      {error && !createOpen && (
        <Alert type="error" title="Error" message={error} onClose={() => setError(null)} />
      )}
      {success && (
        <Alert type="success" title="Success" message={success} onClose={() => setSuccess(null)} />
      )}

      {loading ? (
        <LoadingSpinner label="Loading channels..." />
      ) : loadError ? (
        <Alert type="error" title="Error" message="Failed to load channels" />
      ) : !data?.items?.length ? (
        <Card>
          <div className="text-center py-12">
            <p className="text-content-muted mb-5">No WebChat channels yet.</p>
            <Button onClick={() => setCreateOpen(true)}>Create channel</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.items.map((channel: WebChatChannel) => (
            <Card key={channel.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-medium text-content">{channel.name}</h3>
                  <p className="text-xs text-content-muted font-mono mt-0.5 truncate">
                    {channel.id}
                  </p>
                  <p className="text-xs text-content-subtle mt-0.5">
                    Created {new Date(channel.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => onDelete(channel.id)} title="Delete">
                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                </Button>
              </div>
              <div className="mt-4 pt-4 border-t border-border grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SecretField
                  label="Secret 1"
                  value={channel.secret1 || ''}
                  revealed={revealed.has(`${channel.id}-1`)}
                  copied={copiedKey === `${channel.id}-1`}
                  onToggle={() => toggleReveal(`${channel.id}-1`)}
                  onCopy={() => copy(channel.secret1 || '', `${channel.id}-1`)}
                />
                <SecretField
                  label="Secret 2"
                  value={channel.secret2 || ''}
                  revealed={revealed.has(`${channel.id}-2`)}
                  copied={copiedKey === `${channel.id}-2`}
                  onToggle={() => toggleReveal(`${channel.id}-2`)}
                  onCopy={() => copy(channel.secret2 || '', `${channel.id}-2`)}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        isOpen={createOpen}
        title="New WebChat channel"
        onClose={() => {
          setCreateOpen(false);
          setError(null);
          setForm({ name: '' });
        }}
        onAction={create}
        loading={busy}
        actionLabel="Create"
      >
        <div className="space-y-4">
          {error && <Alert type="error" title="Error" message={error} />}
          <Input
            label="Channel name"
            placeholder="e.g. Customer support"
            value={form.name}
            onChange={(e) => setForm({ name: e.target.value })}
            helper="Secrets are generated automatically"
          />
        </div>
      </Modal>
    </div>
  );
};

const SecretField: React.FC<{
  label: string;
  value: string;
  revealed: boolean;
  copied: boolean;
  onToggle: () => void;
  onCopy: () => void;
}> = ({ label, value, revealed, copied, onToggle, onCopy }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wider text-content-subtle mb-1.5">{label}</p>
    <div className="bg-surface-muted border border-border rounded-lg p-2.5 font-mono text-xs break-all min-h-[2.25rem]">
      {revealed ? value : '••••••••••••••••'}
    </div>
    <div className="flex gap-1 mt-1.5">
      <Button size="sm" variant="ghost" onClick={onToggle} className="flex-1">
        {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        {revealed ? 'Hide' : 'Reveal'}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCopy}>
        <Copy className={`h-3 w-3 ${copied ? 'text-emerald-500' : ''}`} />
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  </div>
);
