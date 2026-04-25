import { getCurrentUserQueryFn } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

const useAuth = () => {
  const query = useQuery({
    queryKey: ["authUser"],
    queryFn: getCurrentUserQueryFn,
    staleTime: 0,
    // Retries are left to QueryProvider's global predicate, which only retries
    // network errors. A 401 here means "logged out", not a transient failure,
    // so retrying it just multiplies refresh round trips on every page load.
  });
  return query;
};

export default useAuth;
