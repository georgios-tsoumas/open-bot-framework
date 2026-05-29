import React from 'react';
import { Input } from './Input';

export interface BotFormValues {
  handle: string;
  endpoint: string;
  schemaVersion: string;
}

interface BotFormProps {
  value: BotFormValues;
  onChange: (next: BotFormValues) => void;
}

export const BotForm: React.FC<BotFormProps> = ({ value, onChange }) => {
  const set = <K extends keyof BotFormValues>(k: K, v: BotFormValues[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="space-y-4">
      <Input
        label="Bot handle"
        placeholder="my-bot"
        value={value.handle}
        onChange={(e) => set('handle', e.target.value)}
        helper="4–64 chars, alphanumeric and hyphens"
      />
      <Input
        label="Endpoint"
        placeholder="https://api.example.com"
        value={value.endpoint}
        onChange={(e) => set('endpoint', e.target.value)}
      />
      <Input
        label="Schema version"
        value={value.schemaVersion}
        onChange={(e) => set('schemaVersion', e.target.value)}
      />
    </div>
  );
};

export const emptyBotForm: BotFormValues = { handle: '', endpoint: '', schemaVersion: 'v1.3' };
