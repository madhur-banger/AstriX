import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import PasswordStrengthIndicator from "@/components/auth/password-strength-indicator";
import { passwordSchema } from "@/lib/password";
import { changePasswordMutationFn } from "@/lib/api";
import { getErrorMessage } from "@/lib/helper";
import { toast } from "@/hooks/use-toast";
import { Loader } from "lucide-react";
import { useState } from "react";

const formSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: passwordSchema,
    confirmNewPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: "Passwords do not match",
    path: ["confirmNewPassword"],
  });

type FormValues = z.infer<typeof formSchema>;

const ChangePasswordCard = () => {
  const [showPasswordRequirements, setShowPasswordRequirements] =
    useState(false);

  const { mutate, isPending } = useMutation({
    mutationFn: changePasswordMutationFn,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmNewPassword: "",
    },
  });

  const watchedPassword = form.watch("newPassword");

  const onSubmit = (values: FormValues) => {
    if (isPending) return;
    mutate(values, {
      onSuccess: () => {
        toast({
          title: "Password changed",
          description: "Other devices have been signed out.",
        });
        form.reset();
        setShowPasswordRequirements(false);
      },
      onError: (error) => {
        toast({
          title: "Error",
          description: getErrorMessage(error),
          variant: "destructive",
        });
      },
    });
  };

  return (
    <div className="w-full h-auto max-w-full">
      <div className="h-full">
        <div className="mb-5 border-b">
          <h1 className="text-[17px] tracking-[-0.16px] dark:text-[#fcfdffef] font-semibold mb-1.5 text-center sm:text-left">
            Change password
          </h1>
        </div>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="currentPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                    Current password
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      className="!h-[48px]"
                      autoComplete="current-password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                    New password
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      className="!h-[48px]"
                      autoComplete="new-password"
                      onFocus={() => setShowPasswordRequirements(true)}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                  {showPasswordRequirements && (
                    <PasswordStrengthIndicator password={watchedPassword} />
                  )}
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirmNewPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                    Confirm new password
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      className="!h-[48px]"
                      autoComplete="new-password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end">
              <Button
                className="h-[40px] font-semibold"
                disabled={isPending}
                type="submit"
              >
                {isPending && <Loader className="animate-spin mr-2 h-4 w-4" />}
                Change password
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
};

export default ChangePasswordCard;
