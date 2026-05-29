import React from 'react';
import { AlertCircle, CheckCircle, Info, X } from 'lucide-react';

interface AlertProps {
  type: 'error' | 'success' | 'info';
  title: string;
  message: string;
  onClose?: () => void;
}

export const Alert: React.FC<AlertProps> = ({ type, title, message, onClose }) => {
  const styles = {
    error: 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-300',
    success: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300',
    info: 'bg-primary-500/10 border-primary-500/30 text-primary-700 dark:text-primary-300',
  }[type];

  const Icon = { error: AlertCircle, success: CheckCircle, info: Info }[type];

  return (
    <div className={`rounded-lg border p-3.5 ${styles}`}>
      <div className="flex gap-3">
        <Icon className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm">{title}</h3>
          <p className="text-sm mt-0.5 opacity-90">{message}</p>
        </div>
        {onClose && (
          <button onClick={onClose} className="opacity-60 hover:opacity-100 transition-opacity">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
};
