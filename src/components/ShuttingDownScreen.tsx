import { FullPageState } from './FullPageState';

export function ShuttingDownScreen() {
  return (
    <FullPageState
      title="Shutting down"
      subtitle="Closing connections. Please wait while we shut down..."
      showSpinner
    />
  );
}
