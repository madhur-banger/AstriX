import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import Logo from "@/components/logo";

type LegalPageProps = {
  title: string;
  lastUpdated: string;
  children: ReactNode;
};

const LegalPage = ({ title, lastUpdated, children }: LegalPageProps) => {
  return (
    <div className="min-h-svh bg-muted py-10 px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <Link
          to="/"
          className="flex items-center gap-2 self-center font-medium"
        >
          <Logo />
          AstriX
        </Link>

        <div className="rounded-lg border border-yellow-500/40 bg-yellow-50 p-4 dark:bg-yellow-950/30">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-yellow-600 dark:text-yellow-500" />
            <div>
              <p className="text-sm font-semibold text-yellow-900 dark:text-yellow-200">
                Draft - not reviewed by legal counsel
              </p>
              <p className="text-sm text-yellow-900/80 dark:text-yellow-200/80">
                This is a draft template and has not been reviewed by legal
                counsel. Do not treat this as a final, binding policy until
                reviewed.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-background p-8">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Last updated: {lastUpdated}
          </p>

          <div className="mt-8 space-y-8 text-sm leading-relaxed text-foreground/90 [&_a]:underline [&_a]:underline-offset-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-4 [&_li]:list-disc [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:space-y-1">
            {children}
          </div>
        </div>

        <div className="text-center text-sm text-muted-foreground">
          <Link to="/" className="underline underline-offset-4">
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
};

export default LegalPage;
