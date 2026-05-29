import React, { useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  actionLabel?: string;
  onAction?: () => void;
  loading?: boolean;
  destructive?: boolean;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  title,
  children,
  onClose,
  actionLabel = 'Save',
  onAction,
  loading = false,
  destructive = false,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-surface-raised rounded-xl shadow-xl max-w-md w-full border border-border">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold text-content">{title}</h2>
          <button
            onClick={onClose}
            className="text-content-muted hover:text-content p-1 rounded transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        <div className="border-t border-border px-6 py-3 flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3.5 py-2 text-sm font-medium text-content bg-surface-muted hover:bg-surface border border-border rounded-lg transition-colors"
          >
            Cancel
          </button>
          {onAction && (
            <button
              onClick={onAction}
              disabled={loading}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-primary-600 hover:bg-primary-700'
              }`}
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
