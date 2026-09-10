import { ChevronDown, Loader, UserX } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/reusable/confirm-dialog";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  getAvatarColor,
  getAvatarFallbackText,
  getErrorMessage,
} from "@/lib/helper";
import { useAuthContext } from "@/context/auth-provider";
import useWorkspaceId from "@/hooks/use-workspace-id";
import useConfirmDialog from "@/hooks/use-confirm-dialog";
import useGetWorkspaceMembers from "@/hooks/api/use-get-workspace-members";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  changeWorkspaceMemberRoleMutationFn,
  removeWorkspaceMemberMutationFn,
} from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import { Permissions } from "@/constant";
import { AllMembersInWorkspaceResponseType } from "@/types/api.type";

type MemberRow = AllMembersInWorkspaceResponseType["members"][number];

const AllMembers = () => {
  const { user, workspace, hasPermission } = useAuthContext();

  const canChangeMemberRole = hasPermission(Permissions.CHANGE_MEMBER_ROLE);
  const canRemoveMember = hasPermission(Permissions.REMOVE_MEMBER);

  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  const { data, isPending } = useGetWorkspaceMembers(workspaceId);
  const members = data?.members || [];
  const roles = data?.roles || [];

  const { mutate, isPending: isLoading } = useMutation({
    mutationFn: changeWorkspaceMemberRoleMutationFn,
  });

  const { open, context, onOpenDialog, onCloseDialog } =
    useConfirmDialog<MemberRow>();
  const removeMutation = useMutation({
    mutationFn: removeWorkspaceMemberMutationFn,
  });

  const handleSelect = (roleId: string, memberId: string) => {
    if (!roleId || !memberId) return;
    const payload = {
      workspaceId,
      data: {
        roleId,
        memberId,
      },
    };
    mutate(payload, {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: ["members", workspaceId],
        });
        toast({
          title: "Success",
          description: "Member's role changed successfully",
          variant: "success",
        });
      },
      onError: (error) => {
        toast({
          title: "Error",
          description: error.message,
          variant: "destructive",
        });
      },
    });
  };

  const handleRemove = () => {
    if (!context) return;
    removeMutation.mutate(
      { workspaceId, memberId: context._id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: ["members", workspaceId],
          });
          toast({ title: "Member removed" });
          onCloseDialog();
        },
        onError: (error) => {
          toast({
            title: "Error",
            description: getErrorMessage(error),
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <div className="grid gap-6 pt-2">
      {isPending ? (
        <Loader className="w-8 h-8 animate-spin place-self-center flex" />
      ) : null}

      {members?.map((member) => {
        const name = member.userId?.name;
        const initials = getAvatarFallbackText(name);
        const avatarColor = getAvatarColor(name);
        const isOwner = member.userId._id === workspace?.owner;
        const isSelf = member.userId._id === user?._id;
        return (
          <div
            key={member._id}
            className="flex items-center justify-between space-x-4"
          >
            <div className="flex items-center space-x-4">
              <Avatar className="h-8 w-8">
                <AvatarImage
                  src={member.userId?.profilePicture || ""}
                  alt="Image"
                />
                <AvatarFallback className={avatarColor}>
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium leading-none">{name}</p>
                <p className="text-sm text-muted-foreground">
                  {member.userId.email}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto min-w-24 capitalize disabled:opacity-95 disabled:pointer-events-none"
                    disabled={
                      isLoading ||
                      !canChangeMemberRole ||
                      member.userId._id === user?._id
                    }
                  >
                    {member.role.name?.toLowerCase()}{" "}
                    {canChangeMemberRole && member.userId._id !== user?._id && (
                      <ChevronDown className="text-muted-foreground" />
                    )}
                  </Button>
                </PopoverTrigger>
                {canChangeMemberRole && (
                  <PopoverContent className="p-0" align="end">
                    <Command>
                      <CommandInput
                        placeholder="Select new role..."
                        disabled={isLoading}
                        className="disabled:pointer-events-none"
                      />
                      <CommandList>
                        {isLoading ? (
                          <Loader className="w-8 h-8 animate-spin place-self-center flex my-4" />
                        ) : (
                          <>
                            <CommandEmpty>No roles found.</CommandEmpty>
                            <CommandGroup>
                              {roles?.map(
                                (role) =>
                                  role.name !== "OWNER" && (
                                    <CommandItem
                                      key={role._id}
                                      disabled={isLoading}
                                      className="disabled:pointer-events-none gap-1 mb-1  flex flex-col items-start px-4 py-2 cursor-pointer"
                                      onSelect={() => {
                                        handleSelect(
                                          role._id,
                                          member.userId._id
                                        );
                                      }}
                                    >
                                      <p className="capitalize">
                                        {role.name?.toLowerCase()}
                                      </p>
                                      <p className="text-sm text-muted-foreground">
                                        {role.name === "ADMIN" &&
                                          `Can view, create, edit tasks, project and manage settings .`}

                                        {role.name === "MEMBER" &&
                                          `Can view,edit only task created by.`}
                                      </p>
                                    </CommandItem>
                                  )
                              )}
                            </CommandGroup>
                          </>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                )}
              </Popover>
              {canRemoveMember && !isOwner && !isSelf && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive"
                  aria-label={`Remove ${name}`}
                  onClick={() => onOpenDialog(member)}
                >
                  <UserX className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        );
      })}

      <ConfirmDialog
        isOpen={open}
        isLoading={removeMutation.isPending}
        onClose={onCloseDialog}
        onConfirm={handleRemove}
        title="Remove member"
        description={`Remove ${
          context?.userId?.name || "this member"
        } from the workspace? They will lose access immediately.`}
        confirmText="Remove"
        cancelText="Cancel"
      />
    </div>
  );
};

export default AllMembers;
