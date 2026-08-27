import { useLocation, useNavigate } from "react-router-dom";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyGlyph, EmptyShell } from "@/components/coeval";

export function NotFoundScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <EmptyShell
      eyebrow="404 · route not found"
      title="That page isn't here."
      body={
        <>
          You may have followed a stale link, deep-linked into a case that has been deleted,
          or hit a route that never existed.
          {location.pathname ? (
            <>
              {" "}The address was <span className="font-mono">{location.pathname}</span>.
            </>
          ) : null}
        </>
      }
      art={<EmptyGlyph kind="404" />}
      primary={
        <Button variant="primary" onClick={() => navigate("/")}>
          Back to overview
        </Button>
      }
      secondary={
        <Button variant="ghost" onClick={() => navigate("/traces")}>
          Search Traces
        </Button>
      }
    />
  );
}

interface ApiUnavailableProps {
  retry?: () => void;
  status?: number;
  lastOkAt?: string;
}

export function ApiUnavailableScreen({ retry, status, lastOkAt }: ApiUnavailableProps) {
  return (
    <EmptyShell
      eyebrow="Connection lost"
      title="Coeval can't reach its backend right now."
      body={
        <>
          Existing records remain on the server. This page cannot load them or save new decisions
          until the connection returns.
          {lastOkAt ? (
            <>
              {" "}Last successful call <span className="font-mono">{lastOkAt}</span>.
            </>
          ) : null}
        </>
      }
      art={<EmptyGlyph kind="offline" />}
      // EmptyShell truthy-checks the slot, so null is safe and avoids the
      // undefined-vs-omitted mismatch under exactOptionalPropertyTypes.
      primary={
        retry ? (
          <Button variant="primary" onClick={retry}>
            <RefreshCcw /> Try again
          </Button>
        ) : null
      }
      secondary={
        <span className="self-center font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
          {status ? `http · ${status}` : "net::ERR_INTERNET_DISCONNECTED"}
        </span>
      }
    />
  );
}

// P0-2 error taxonomy: "you're signed in, but this needs a different role" is
// its own state — not a 404, not an API failure.
export function PermissionDeniedScreen({
  requiredRole,
  onBack
}: {
  requiredRole?: string;
  onBack: () => void;
}) {
  return (
    <EmptyShell
      eyebrow="Not authorized"
      title="This action needs an owner."
      body={
        <>
          Your account doesn't have the role this surface requires
          {requiredRole ? (
            <>
              {" "}(<span className="font-mono">{requiredRole}</span>)
            </>
          ) : null}
          . Nothing was changed. Ask a project owner to do this, or to change your role.
        </>
      }
      art={<EmptyGlyph kind="locked" />}
      primary={
        <Button variant="primary" onClick={onBack}>
          Back to overview
        </Button>
      }
    />
  );
}
