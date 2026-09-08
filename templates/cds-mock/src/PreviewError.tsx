import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@colosseumcoinckr/cds/components/alert";

interface Props {
  screen: string;
  children: ReactNode;
}

/**
 * A screen that throws would blank the iframe, and the planner has no console
 * to look at. Show the message instead, phrased as something they can say back
 * in the chat.
 */
export class PreviewError extends Component<Props, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[preview] ${this.props.screen}`, error, info.componentStack);
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="p-6">
        <Alert intent="danger">
          <AlertTitle>화면에 오류가 있습니다</AlertTitle>
          <AlertDescription>
            <p>채팅에 "{this.props.screen} 화면 오류 고쳐줘"라고 말해 주세요.</p>
            <p className="text-text-description mt-2 font-mono">{this.state.message}</p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
}
