import React, { useState } from 'react';
import { Plus, Trash2, Edit2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useFetch } from '@/hooks/useFetch';
import { apiClient } from '@/services/api';
import {
  Card,
  Button,
  LoadingSpinner,
  Alert,
  Modal,
  BotForm,
  emptyBotForm,
  BotFormValues,
} from '@/components';
import { OpenBot } from '@/types';

export const BotsListPage: React.FC = () => {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<OpenBot | null>(null);
  const [form, setForm] = useState<BotFormValues>(emptyBotForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data, loading, error: loadError, refetch } = useFetch(
    () => apiClient.getOpenBots(0, 100),
    []
  );

  const openCreate = () => {
    setForm(emptyBotForm);
    setError(null);
    setCreateOpen(true);
  };

  const openEdit = (bot: OpenBot) => {
    setEditing(bot);
    setForm({ handle: bot.handle, endpoint: bot.endpoint, schemaVersion: bot.schemaVersion });
    setError(null);
  };

  const submit = async () => {
    if (!form.handle || !form.endpoint) {
      setError('Handle and endpoint are required');
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await apiClient.updateOpenBot(editing.id, form);
        setSuccess('Bot updated');
        setEditing(null);
      } else {
        await apiClient.createOpenBot(form);
        setSuccess('Bot created');
        setCreateOpen(false);
      }
      setForm(emptyBotForm);
      await refetch();
    } catch (err) {
      setError((err as Error).message || 'Operation failed');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('Delete this bot?')) return;
    try {
      await apiClient.deleteOpenBot(id);
      setSuccess('Bot deleted');
      await refetch();
    } catch (err) {
      setError((err as Error).message || 'Failed to delete');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-content">Bots</h1>
          <p className="text-sm text-content-muted mt-1">
            Manage bot definitions and their integrations
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          New bot
        </Button>
      </div>

      {error && !createOpen && !editing && (
        <Alert type="error" title="Error" message={error} onClose={() => setError(null)} />
      )}
      {success && (
        <Alert type="success" title="Success" message={success} onClose={() => setSuccess(null)} />
      )}

      {loading ? (
        <LoadingSpinner label="Loading bots..." />
      ) : loadError ? (
        <Alert type="error" title="Error" message="Failed to load bots" />
      ) : !data?.items || data.items.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <p className="text-content-muted mb-5">No bots yet.</p>
            <Button onClick={openCreate}>Create your first bot</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {data.items.map((bot: OpenBot) => (
            <Card
              key={bot.id}
              clickable
              onClick={() => navigate(`/bots/${bot.id}`)}
              className="!p-4"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-10 w-10 rounded-lg bg-primary-500/15 text-primary-500 flex items-center justify-center font-semibold">
                    {bot.handle.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-medium text-content truncate">{bot.handle}</h3>
                    <p className="text-xs text-content-muted truncate">{bot.endpoint}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <div className="text-right hidden sm:block">
                    <p className="text-[10px] uppercase tracking-wider text-content-subtle">
                      Schema
                    </p>
                    <p className="text-xs font-medium text-content">{bot.schemaVersion}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEdit(bot);
                      }}
                      title="Edit"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(bot.id);
                      }}
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        isOpen={createOpen || !!editing}
        title={editing ? 'Edit bot' : 'New bot'}
        onClose={() => {
          setCreateOpen(false);
          setEditing(null);
          setError(null);
          setForm(emptyBotForm);
        }}
        onAction={submit}
        loading={busy}
        actionLabel={editing ? 'Save changes' : 'Create'}
      >
        <div className="space-y-4">
          {error && <Alert type="error" title="Error" message={error} />}
          <BotForm value={form} onChange={setForm} />
        </div>
      </Modal>
    </div>
  );
};
