import React from 'react';

export interface LoadingScreenProps {
  message?: string;
}

export const LoadingScreen: React.FC<LoadingScreenProps> = ({
  message = 'Loading...',
}) => {
  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center font-sans text-neutral-900 antialiased electron-drag-region">
      <div className="w-full max-w-md pb-20">
        <div className="text-center space-y-1 flex flex-col items-center">
          <h2 className="text-3xl font-bold text-gray-900">IPTRADE</h2>
          <p className="text-gray-400">{message}</p>
        </div>
      </div>
    </div>
  );
};
