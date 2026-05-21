import { Check, X } from "lucide-react";
import { passwordRequirements } from "@/lib/password";

const PasswordStrengthIndicator = ({ password }: { password: string }) => {
  if (!password) return null;

  return (
    <div className="mt-2 space-y-1">
      {passwordRequirements.map((req) => {
        const isMet = req.regex.test(password);
        return (
          <div
            key={req.label}
            className={`flex items-center gap-2 text-xs ${
              isMet ? "text-green-600" : "text-muted-foreground"
            }`}
          >
            {isMet ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
            {req.label}
          </div>
        );
      })}
    </div>
  );
};

export default PasswordStrengthIndicator;
