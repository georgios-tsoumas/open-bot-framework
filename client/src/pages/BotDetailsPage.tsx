import React, { useState } from 'react';
import { Edit2, KeyRound, MessageSquare, ArrowRight } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
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

export const BotDetailsPage: React.FC = () => {
  const { botId = '' } = useParams();
  const navigate = useNavigate();

  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<BotFormValues>(emptyBotForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: bot, loading, error: loadError, refetch } = useFetch(
    () => apiClient.getOpenBotById(botId),
    [botId]
  );
  const { data: secretsCount } = useFetch(() => apiClient.getOpenBotSecrets(botId, 0, 1), [botId]);
  const { data: channelsCount } = useFetch(() => apiClient.getWebChatChannels(botId, 0, 1), [botId]);

  const openEdit = () => {
    if (!bot) return;
    setForm({ handle: bot.handle, endpoint: bot.endpoint, schemaVersion: bot.schemaVersion });
    setError(null);
    setEditOpen(true);
  };

  const submit = async () => {
    if (!form.handle || !form.endpoint) {
      setError('Handle and endpoint are required');
      return;
    }
    setBusy(true);
    try {
      await apiClient.updateOpenBot(botId, form);
      setSuccess('Bot updated');
      setEditOpen(false);
      await refetch();
    } catch (err) {
      setError((err as Error).message || 'Failed to update');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingSpinner label="Loading bot..." />;
  if (loadError) return <Alert type="error" title="Error" message="Failed to load bot details" />;
  if (!bot) return <Alert type="error" title="Error" message="Bot not found" />;

  return (
    <div className="space-y-6">
      {success && (
        <Alert type="success" title="Success" message={success} onClose={() => setSuccess(null)} />
      )}

      <div className="flex items-start justify-between gap-4">
        <div>
          <button
            onClick={() => navigate('/bots')}
            className="text-xs text-content-muted hover:text-content mb-2"
          >
            ← Back to bots
          </button>
          <h1 className="text-2xl font-semibold text-content">{bot.handle}</h1>
          <p className="text-sm text-content-muted mt-1 font-mono truncate">{bot.endpoint}</p>
        </div>
        <Button onClick={openEdit} variant="secondary">
          <Edit2 className="h-4 w-4" />
          Edit
        </Button>
      </div>

      <Card>
        <h2 className="text-sm font-semibold text-content uppercase tracking-wider mb-4">
          Information
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 text-sm">
          <Field label="Handle" value={bot.handle} mono />
          <Field label="Schema version" value={bot.schemaVersion} />
          <Field label="Endpoint" value={bot.endpoint} mono />
          <Field label="Created" value={new Date(bot.createdAt).toLocaleString()} />
          <Field label="Updated" value={new Date(bot.updatedAt).toLocaleString()} />
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard
          icon={<KeyRound className="h-5 w-5" />}
          title="Credentials"
          subtitle="API keys and secrets"
          count={secretsCount?.total ?? 0}
          onClick={() => navigate(`/bots/${botId}/credentials`)}
        />
        <StatCard
          icon={<MessageSquare className="h-5 w-5" />}
          title="WebChat channels"
          subtitle="Embedded chat integrations"
          count={channelsCount?.total ?? 0}
          onClick={() => navigate(`/bots/${botId}/webchat`)}
        />
      </div>

      <Modal
        isOpen={editOpen}
        title="Edit bot"
        onClose={() => {
          setEditOpen(false);
          setError(null);
        }}
        onAction={submit}
        loading={busy}
        actionLabel="Save changes"
      >
        <div className="space-y-4">
          {error && <Alert type="error" title="Error" message={error} />}
          <BotForm value={form} onChange={setForm} />
        </div>
      </Modal>
    </div>
  );
};

const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wider text-content-subtle">{label}</p>
    <p className={`mt-1 text-content break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</p>
  </div>
);

const StatCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count: number;
  onClick: () => void;
}> = ({ icon, title, subtitle, count, onClick }) => (
  <Card clickable onClick={onClick}>
    <div className="flex items-start justify-between">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-primary-500/15 text-primary-500 flex items-center justify-center">
          {icon}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-content">{title}</h3>
          <p className="text-xs text-content-muted mt-0.5">{subtitle}</p>
        </div>
      </div>
      <ArrowRight className="h-4 w-4 text-content-subtle" />
    </div>
    <div className="mt-5">
      <span className="text-3xl font-semibold text-content">{count}</span>
    </div>
  </Card>
);
