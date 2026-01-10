// client/src/page/auth/SignUp.tsx
// ============================================
// SIGN UP PAGE - Updated with Strong Password Validation
// ============================================

import { Link, useNavigate } from "react-router-dom";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
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
import GoogleOauthButton from "@/components/auth/google-oauth-button";
import { useMutation } from "@tanstack/react-query";
import { registerMutationFn } from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import { Loader, Check, X } from "lucide-react";
import { useState } from "react";

// ============================================
// PASSWORD REQUIREMENTS
// ============================================

const passwordRequirements = [
  { regex: /.{8,}/, label: "At least 8 characters" },
  { regex: /[A-Z]/, label: "One uppercase letter" },
  { regex: /[a-z]/, label: "One lowercase letter" },
  { regex: /[0-9]/, label: "One number" },
  { regex: /[^A-Za-z0-9]/, label: "One special character (!@#$%^&*)" },
];

// ============================================
// VALIDATION SCHEMA
// ============================================

const formSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be at most 50 characters"),
  email: z
    .string()
    .trim()
    .email("Invalid email address")
    .min(1, "Email is required"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number")
    .regex(
      /[^A-Za-z0-9]/,
      "Password must contain at least one special character"
    ),
});

type FormValues = z.infer<typeof formSchema>;

// ============================================
// PASSWORD STRENGTH INDICATOR
// ============================================

const PasswordStrengthIndicator = ({ password }: { password: string }) => {
  if (!password) return null;

  return (
    <div className="mt-2 space-y-1">
      {passwordRequirements.map((req, index) => {
        const isMet = req.regex.test(password);
        return (
          <div
            key={index}
            className={`flex items-center gap-2 text-xs ${
              isMet ? "text-green-600" : "text-muted-foreground"
            }`}
          >
            {isMet ? (
              <Check className="w-3 h-3" />
            ) : (
              <X className="w-3 h-3" />
            )}
            {req.label}
          </div>
        );
      })}
    </div>
  );
};

// ============================================
// COMPONENT
// ============================================

const SignUp = () => {
  const navigate = useNavigate();
  const [showPasswordRequirements, setShowPasswordRequirements] =
    useState(false);

  const { mutate, isPending } = useMutation({
    mutationFn: registerMutationFn,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
    },
  });

  const watchedPassword = form.watch("password");

  const onSubmit = (values: FormValues) => {
    if (isPending) return;

    mutate(values, {
      onSuccess: () => {
        toast({
          title: "Success",
          description: "Account created successfully. Please sign in.",
        });
        navigate("/sign-in");
      },
      onError: (error: any) => {
        toast({
          title: "Error",
          description: error.response?.data?.message || error.message,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link
          to="/"
          className="flex items-center gap-2 self-center font-medium"
        >
          <Logo />
          Team Sync.
        </Link>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-xl">Create an account</CardTitle>
              <CardDescription>
                Signup with your Email or Google account
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)}>
                  <div className="grid gap-6">
                    <div className="flex flex-col gap-4">
                      <GoogleOauthButton label="Signup" />
                    </div>
                    <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
                      <span className="relative z-10 bg-background px-2 text-muted-foreground">
                        Or continue with
                      </span>
                    </div>
                    <div className="grid gap-3">
                      <FormField
                        control={form.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                              Name
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder="John Doe"
                                className="!h-[48px]"
                                autoComplete="name"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                              Email
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder="m@example.com"
                                className="!h-[48px]"
                                autoComplete="email"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                              Password
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
                      <Button disabled={isPending} type="submit" className="w-full">
                        {isPending && <Loader className="animate-spin mr-2" />}
                        Sign up
                      </Button>
                    </div>
                    <div className="text-center text-sm">
                      Already have an account?{" "}
                      <Link
                        to="/sign-in"
                        className="underline underline-offset-4"
                      >
                        Sign in
                      </Link>
                    </div>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
          <div className="text-balance text-center text-xs text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a]:hover:text-primary">
            By clicking continue, you agree to our{" "}
            <a href="#">Terms of Service</a> and <a href="#">Privacy Policy</a>.
          </div>
        </div>
      </div>
    </div>
  );
};

export default SignUp;