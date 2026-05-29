import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  clickable?: boolean;
  onClick?: () => void;
}

export const Card: React.FC<CardProps> = ({
  children,
  className = '',
  clickable = false,
  onClick,
}) => {
  return (
    <div
      onClick={onClick}
      className={`bg-surface-raised rounded-xl border border-border p-6 transition-all ${
        clickable
          ? 'cursor-pointer hover:border-primary-400 hover:shadow-md'
          : ''
      } ${className}`}
    >
      {children}
    </div>
  );
};
