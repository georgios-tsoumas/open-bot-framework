import React, { useState } from 'react';
import { Plus, Trash2, Copy } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useFetch } from '@/hooks/useFetch';
import { apiClient } from '@/services/api';
import { Card, Button, LoadingSpinner, Alert, Modal, Input } from '@/components';
import { OpenBotSecret } from '@/types';

export const CredentialsPage: React.FC = () => {
  const { botId = '' } = useParams();
  const navigate = useNavigate();

  const [createOpen, setCreateOpen] = useState(false);
  const [secretModalOpen, setSecretModalOpen] = useState(false);
  const [form, setForm] = useState({ description: '', expiresAt: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, loading, error: loadError, refetch } = useFetch(
    () => apiClient.getOpenBotSecrets(botId, 0, 100),
    [botId]
  );

  const create = async () => {
    if (!form.description) {
      setError('Description is required');
      return;
    }
    setBusy(true);
    try {
      const r = await apiClient.createOpenBotSecret(botId, {
        description: form.description,
        expiresAt: form.expiresAt ? new Date(form.expiresAt) : undefined,
      });
      setNewSecret(r.secret || null);
      setCreateOpen(false);
      setSecretModalOpen(true);
      setForm({ description: '', expiresAt: '' });
    } catch (err) {
      setError((err as Error).message || 'Failed to create');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('Delete this credential?')) return;
    try {
      await apiClient.deleteOpenBotSecret(botId, id);
      setSuccess('Credential deleted');
      await refetch();
    } catch (err) {
      setError((err as Error).message || 'Failed to delete');
    }
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
          <h1 className="text-2xl font-semibold text-content">Credentials</h1>
          <p className="text-sm text-content-muted mt-1">API keys for OAuth2 client-credentials</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New credential
        </Button>
      </div>

      {error && !createOpen && (
        <Alert type="error" title="Error" message={error} onClose={() => setError(null)} />
      )}
      {success && (
        <Alert type="success" title="Success" message={success} onClose={() => setSuccess(null)} />
      )}

      {loading ? (
        <LoadingSpinner label="Loading credentials..." />
      ) : loadError ? (
        <Alert type="error" title="Error" message="Failed to load credentials" />
      ) : !data?.items?.length ? (
        <Card>
          <div className="text-center py-12">
            <p className="text-content-muted mb-5">No credentials yet.</p>
            <Button onClick={() => setCreateOpen(true)}>Create credential</Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.items.map((cred: OpenBotSecret) => (
            <Card key={cred.secretId} className="!p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-medium text-content truncate">{cred.description}</h3>
                  <p className="text-xs text-content-muted mt-1">
                    Created {new Date(cred.createdAt).toLocaleDateString()}
                  </p>
                  {cred.expiresAt && (
                    <p className="text-xs text-amber-500 mt-0.5">
                      Expires {new Date(cred.expiresAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <Button size="sm" variant="ghost" onClick={() => onDelete(cred.secretId)} title="Delete">
                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                </Button>
              </div>
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-[10px] uppercase tracking-wider text-content-subtle mb-1">
                  Secret preview
                </p>
                <code className="text-xs text-content-muted break-all">
                  {cred.secret?.substring(0, 12)}…
                </code>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        isOpen={createOpen}
        title="New credential"
        onClose={() => {
          setCreateOpen(false);
          setError(null);
          setForm({ description: '', expiresAt: '' });
        }}
        onAction={create}
        loading={busy}
        actionLabel="Create"
      >
        <div className="space-y-4">
          {error && <Alert type="error" title="Error" message={error} />}
          <Input
            label="Description"
            placeholder="e.g. Production API key"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <Input
            label="Expires at (optional)"
            type="datetime-local"
            value={form.expiresAt}
            onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
          />
        </div>
      </Modal>

      <Modal
        isOpen={secretModalOpen}
        title="Save your secret"
        onClose={() => {
          setSecretModalOpen(false);
          setNewSecret(null);
          refetch();
        }}
        onAction={() => {
          setSecretModalOpen(false);
          setNewSecret(null);
          refetch();
        }}
        actionLabel="Done"
      >
        <div className="space-y-4">
          <Alert
            type="error"
            title="Save this now"
            message="You won't be able to see this secret again."
          />
          <div className="bg-surface-muted p-3 rounded-lg border border-border">
            <code className="text-xs text-content break-all">{newSecret}</code>
          </div>
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => {
              if (newSecret) {
                navigator.clipboard.writeText(newSecret);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            }}
          >
            <Copy className="h-4 w-4" />
            {copied ? 'Copied' : 'Copy to clipboard'}
          </Button>
        </div>
      </Modal>
    </div>
  );
};
