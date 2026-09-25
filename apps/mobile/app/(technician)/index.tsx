import { router } from 'expo-router';
import { JobCard, type JobSummary } from '@/components/JobCard';
import { ErrorText, Loading, Muted, Screen } from '@/components/ui';
import { useApi } from '@/lib/useApi';

export default function TechnicianFeed() {
  const { data, error, loading } = useApi<{ jobs: JobSummary[] }>('/jobs?feed=nearby');
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <ErrorText error={error} />
      {data?.jobs.length === 0 && (
        <Muted>No open jobs near you right now. Make sure you're verified, available, and have set your services and base location in Profile.</Muted>
      )}
      {data?.jobs.map((j) => <JobCard key={j.id} job={j} onPress={() => router.push(`/job/${j.id}`)} />)}
    </Screen>
  );
}
