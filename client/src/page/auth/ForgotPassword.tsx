import { Link } from "react-router-dom";
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
import { forgotPasswordMutationFn } from "@/lib/api";
import { getErrorMessage } from "@/lib/helper";
import { toast } from "@/hooks/use-toast";
import { Loader } from "lucide-react";
import { useState } from "react";

const formSchema = z.object({
  email: z.string().trim().email("Invalid email address"),
});

type FormValues = z.infer<typeof formSchema>;

const ForgotPassword = () => {
  const [submitted, setSubmitted] = useState(false);

  const { mutate, isPending } = useMutation({
    mutationFn: forgotPasswordMutationFn,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = (values: FormValues) => {
    if (isPending) return;
    mutate(values, {
      onSuccess: () => setSubmitted(true),
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
            <CardTitle className="text-xl">Forgot password</CardTitle>
            <CardDescription>
              Enter your email and we&apos;ll send you a reset link
            </CardDescription>
          </CardHeader>
          <CardContent>
            {submitted ? (
              <div className="space-y-4 text-center text-sm text-muted-foreground">
                <p>
                  If an account exists for that email, we&apos;ve sent a link to
                  reset your password.
                </p>
                <Link
                  to="/sign-in"
                  className="underline underline-offset-4 text-foreground"
                >
                  Back to sign in
                </Link>
              </div>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)}>
                  <div className="grid gap-6">
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
                    <Button
                      disabled={isPending}
                      type="submit"
                      className="w-full"
                    >
                      {isPending && <Loader className="animate-spin mr-2" />}
                      Send reset link
                    </Button>
                    <div className="text-center text-sm">
                      <Link
                        to="/sign-in"
                        className="underline underline-offset-4"
                      >
                        Back to sign in
                      </Link>
                    </div>
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

export default ForgotPassword;
