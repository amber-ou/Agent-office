import { Button } from './ui/Button.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  /** Read-only CC activity dashboard: every native agent's status plus its
   *  observed call history. */
  isAgentPanelOpen: boolean;
  onToggleAgentPanel: () => void;
}

export function BottomToolbar({
  isEditMode,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  isAgentPanelOpen,
  onToggleAgentPanel,
}: BottomToolbarProps) {
  // Agent Office is observation-only: there is no "+ Agent" launcher here.
  // Agents are started from Claude Code itself; the office only watches.
  return (
    <div className="absolute bottom-10 left-10 z-20 flex items-center gap-4 pixel-panel p-4">
      <Button
        variant={isEditMode ? 'active' : 'default'}
        onClick={onToggleEditMode}
        title="Edit office layout"
      >
        Layout
      </Button>
      <Button
        variant={isAgentPanelOpen ? 'active' : 'default'}
        onClick={onToggleAgentPanel}
        title="Claude Code agent status and call history (read-only)"
      >
        Agent
      </Button>
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
      >
        Settings
      </Button>
    </div>
  );
}
