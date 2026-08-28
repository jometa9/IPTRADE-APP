import React from 'react';
import { Loader } from 'lucide-react';

export interface FullPageStateProps {
  title: string;
  subtitle?: string;
  showBrand?: boolean;
  showSpinner?: boolean;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

const containerClass =
  'flex min-h-full flex-col items-center justify-center text-center font-sans text-neutral-900 antialiased';
const spinnerClass = 'h-6 w-6 text-gray-400 m-2 animate-spin';
const titleClass = 'text-lg font-semibold text-gray-600';
const subtitleClass = 'mt-2 text-xs text-gray-400 max-w-md';
const brandClass = 'text-3xl font-bold text-gray-900';
const messageClass = 'text-gray-400';

export const FullPageState: React.FC<FullPageStateProps> = ({
  title,
  subtitle,
  showBrand = false,
  showSpinner = true,
  icon,
  children,
  className = '',
}) => {
  const displayIcon = icon ?? (showSpinner ? <Loader className={spinnerClass} /> : null);

  return (
    <div className={`${containerClass} ${className}`.trim()}>
      <div className="w-full max-w-md pb-14 px-4 flex flex-col items-center">
        {showBrand ? (
          <>
            {displayIcon}
            <h2 className={brandClass}>IPTRADE</h2>
            <p className={messageClass}>{title}</p>
          </>
        ) : (
          <>
            {displayIcon}
            <p className={titleClass}>{title}</p>
            {subtitle && <p className={subtitleClass}>{subtitle}</p>}
          </>
        )}
        {children}
      </div>
    </div>
  );
};
