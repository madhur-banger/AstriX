import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import Logo from "@/components/logo";
import PasswordStrengthIndicator from "@/components/auth/password-strength-indicator";
import { resetPasswordMutationFn } from "@/lib/api";
import { getErrorMessage } from "@/lib/helper";
import { passwordSchema } from "@/lib/password";
import { toast } from "@/hooks/use-toast";
import { useStoreBase } from "@/store/store";
import { Loader } from "lucide-react";
import { useState } from "react";

const formSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type FormValues = z.infer<typeof formSchema>;

const ResetPassword = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [showPasswordRequirements, setShowPasswordRequirements] =
    useState(false);

  const { mutate, isPending } = useMutation({
    mutationFn: resetPasswordMutationFn,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const watchedPassword = form.watch("password");

  const onSubmit = (values: FormValues) => {
    if (isPending || !token) return;

    mutate(
      { token, ...values },
      {
        onSuccess: () => {
          // The backend invalidates every session on a successful reset —
          // clear any local auth state so a stale in-memory token doesn't
          // linger until the next 401 round-trip.
          useStoreBase.getState().clearAuth();
          toast({
            title: "Password reset",
            description: "Please sign in with your new password.",
          });
          navigate("/sign-in", { replace: true });
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
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link
          to="/"
          className="flex items-center gap-2 self-center font-medium"
        >
          <Logo />
          AstriX
        </Link>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Reset password</CardTitle>
            <CardDescription>Enter your new password below</CardDescription>
          </CardHeader>
          <CardContent>
            {!token ? (
              <div className="space-y-4 text-center text-sm text-muted-foreground">
                <p>
                  This reset link is missing or invalid. Request a new one to
                  continue.
                </p>
                <Link
                  to="/forgot-password"
                  className="underline underline-offset-4 text-foreground"
                >
                  Request a new link
                </Link>
              </div>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)}>
                  <div className="grid gap-6">
                    <FormField
                      control={form.control}
                      name="password"
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
                            <PasswordStrengthIndicator
                              password={watchedPassword}
                            />
                          )}
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="confirmPassword"
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
                    <Button
                      disabled={isPending}
                      type="submit"
                      className="w-full"
                    >
                      {isPending && <Loader className="animate-spin mr-2" />}
                      Reset password
                    </Button>
                  </div>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default ResetPassword;
