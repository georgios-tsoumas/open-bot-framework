import React from 'react';
import { Loader2 } from 'lucide-react';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  size = 'md',
  label = 'Loading...',
}) => {
  const sizeClass = { sm: 'h-4 w-4', md: 'h-7 w-7', lg: 'h-10 w-10' }[size];
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10">
      <Loader2 className={`${sizeClass} animate-spin text-primary-500`} />
      {label && <p className="text-sm text-content-muted">{label}</p>}
    </div>
  );
};
