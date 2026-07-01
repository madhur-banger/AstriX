import { Separator } from "@/components/ui/separator";
import UpdateProfileCard from "@/components/account/update-profile-card";
import ChangePasswordCard from "@/components/account/change-password-card";
import SessionsCard from "@/components/account/sessions-card";
import LeaveWorkspaceCard from "@/components/account/leave-workspace-card";
import DeleteAccountCard from "@/components/account/delete-account-card";

const AccountSettings = () => {
  return (
    <div className="w-full h-auto py-2">
      <main>
        <div className="w-full max-w-3xl mx-auto py-3">
          <h2 className="text-[20px] leading-[30px] font-semibold mb-3">
            Account settings
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            These settings apply to your account across every workspace.
          </p>

          <div className="flex flex-col gap-6">
            <UpdateProfileCard />
            <Separator />
            <ChangePasswordCard />
            <Separator />
            <SessionsCard />
            <Separator />
            <LeaveWorkspaceCard />
            <Separator />
            <DeleteAccountCard />
          </div>
        </div>
      </main>
    </div>
  );
};

export default AccountSettings;
