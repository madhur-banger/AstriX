import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useAuthContext } from "@/context/auth-provider";
import { updateProfileMutationFn } from "@/lib/api";
import { getErrorMessage } from "@/lib/helper";
import { toast } from "@/hooks/use-toast";
import { Loader } from "lucide-react";

const formSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be at most 50 characters"),
});

type FormValues = z.infer<typeof formSchema>;

const UpdateProfileCard = () => {
  const { user } = useAuthContext();
  const queryClient = useQueryClient();

  const { mutate, isPending } = useMutation({
    mutationFn: updateProfileMutationFn,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "" },
  });

  useEffect(() => {
    if (user) {
      form.setValue("name", user.name);
    }
  }, [form, user]);

  const onSubmit = (values: FormValues) => {
    if (isPending) return;
    mutate(values, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["authUser"] });
        toast({ title: "Profile updated" });
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
            Profile
          </h1>
        </div>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                      className="!h-[48px]"
                      autoComplete="name"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <Label
                htmlFor="profile-email"
                className="dark:text-[#f1f7feb5] text-sm"
              >
                Email
              </Label>
              <Input
                id="profile-email"
                className="!h-[48px]"
                value={user?.email || ""}
                disabled
              />
            </div>
            <div className="flex justify-end">
              <Button
                className="h-[40px] font-semibold"
                disabled={isPending}
                type="submit"
              >
                {isPending && <Loader className="animate-spin mr-2 h-4 w-4" />}
                Save changes
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
};

export default UpdateProfileCard;
